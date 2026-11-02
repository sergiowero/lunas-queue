// Task state machine (docs/design.md §State machine, ADR 0007).
// Pure TypeScript: the guards receive facts already computed by the caller (test gate,
// approved spec, verdict), so the domain knows no database, herdr or gh.
import {
  type Actor,
  type EscalationReason,
  type ResultKind,
  type SubState,
  TASK_TRANSITIONED,
  type TaskCommand,
  type TaskState,
  TaskTransitionedEvent,
  type TaskTransitionedPayload,
} from "@lunasq/schemas";

export const DEFAULT_MAX_ITERATIONS = 3;
export const DEFAULT_MAX_RETRIES = 3;

export type TaskSnapshot = {
  state: TaskState;
  subState: SubState | null;
  verificationIteration: number;
};

export type CommandInput =
  | { type: "submit_spec"; specComplete: boolean }
  | { type: "request_changes"; hasComments: boolean }
  | { type: "approve"; specApproved: boolean }
  | {
      type: "submit_for_verification";
      testGatePassed: boolean;
      everyCriterionHasTest: boolean;
      hasCommits: boolean;
    }
  // Task without code: the Result replaces verification and the PR (ADR 0007).
  | { type: "submit_result"; resultKind: ResultKind }
  | { type: "verdict_rework"; maxIterations?: number }
  | {
      type: "verdict_pass";
      // Pass verdict recorded by the verifier Run in the current iteration.
      verifierPassed: boolean;
      testGatePassed: boolean;
      testsCoherent: boolean;
      allCriteriaPassed: boolean;
      prCreated: boolean;
    }
  | { type: "delivery_conflict" }
  | { type: "escalate"; reason: EscalationReason; note?: string }
  | { type: "cancel"; note?: string }
  // deliveryInProgress: the verifier Run is still open with the handoff saved (delivery).
  | { type: "pause"; deliveryInProgress: boolean }
  // resetIteration: the human grants a new complete verification cycle.
  | { type: "resume"; resumeTo: TaskState; resetIteration?: boolean }
  | { type: "dispatch" }
  | { type: "ask_human" }
  | { type: "answer"; agentAlive: boolean }
  // attempt: consecutive failed Runs in the phase, counting this one.
  | { type: "run_failed"; attempt: number; maxRetries?: number };

export type TransitionErrorCode = "invalid_transition" | "actor_not_allowed" | "guard_failed";

export type TransitionResult =
  | { ok: true; next: TaskSnapshot; event: TaskTransitionedEvent }
  | { ok: false; error: { code: TransitionErrorCode; message: string } };

/** Who can emit each command (transition table of the design). */
export const COMMAND_ACTORS: Readonly<Record<TaskCommand, readonly Actor[]>> = {
  submit_spec: ["agent"],
  request_changes: ["human"],
  approve: ["human"],
  submit_for_verification: ["agent"],
  submit_result: ["agent"],
  verdict_rework: ["agent"],
  // The verifier records its verdict in the handoff; delivery emits the pass after the PR.
  verdict_pass: ["system"],
  delivery_conflict: ["system"],
  escalate: ["system"],
  cancel: ["human"],
  pause: ["human"],
  resume: ["human"],
  dispatch: ["system"],
  ask_human: ["agent"],
  answer: ["human"],
  run_failed: ["system"],
};

const AGENT_STATES: readonly TaskState[] = ["draft", "in_progress", "verification"];
const TERMINAL_STATES: readonly TaskState[] = ["completed", "cancelled"];
const PAUSABLE_STATES: readonly TaskState[] = ["draft", "refined", "in_progress", "verification"];
const RESUMABLE_STATES: readonly TaskState[] = ["draft", "refined", "in_progress", "verification"];

/** Sub-state with which a state is entered: queued if it carries an agent, null if not. */
export function subStateFor(state: TaskState): SubState | null {
  return AGENT_STATES.includes(state) ? "queued" : null;
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

function isCoherent(task: TaskSnapshot): boolean {
  const iterationOk =
    Number.isInteger(task.verificationIteration) && task.verificationIteration >= 0;
  const subStateOk = AGENT_STATES.includes(task.state)
    ? task.subState !== null
    : task.subState === null;
  return iterationOk && subStateOk;
}

const isPositiveInt = (n: number) => Number.isInteger(n) && n > 0;

type Outcome = {
  to: TaskState;
  subState?: SubState | null;
  iteration?: number;
  reason?: EscalationReason;
};
type Rule = {
  // Origins (state and sub-state) from which the command applies.
  from: (task: TaskSnapshot) => boolean;
  guard?: () => string | undefined;
  outcome: () => Outcome;
};

const at =
  (state: TaskState, ...subStates: (SubState | null)[]) =>
  (task: TaskSnapshot) =>
    task.state === state && subStates.includes(task.subState);
const inAgentState =
  (subState: SubState) =>
  (task: TaskSnapshot): boolean =>
    AGENT_STATES.includes(task.state) && task.subState === subState;
const requireAll = (facts: Record<string, boolean>) => () => {
  const missing = Object.entries(facts)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return missing.length > 0 ? `faltan: ${missing.join(", ")}` : undefined;
};

function rule(task: TaskSnapshot, command: CommandInput): Rule {
  const iteration = task.verificationIteration;
  switch (command.type) {
    case "submit_spec":
      return {
        from: at("draft", "running"),
        guard: requireAll({ specComplete: command.specComplete }),
        outcome: () => ({ to: "refined" }),
      };
    case "request_changes":
      return {
        from: at("refined", null),
        guard: requireAll({ hasComments: command.hasComments }),
        outcome: () => ({ to: "draft" }),
      };
    case "approve":
      return {
        from: at("refined", null),
        guard: requireAll({ specApproved: command.specApproved }),
        outcome: () => ({ to: "in_progress" }),
      };
    case "submit_for_verification":
      return {
        from: at("in_progress", "running"),
        guard: requireAll({
          testGatePassed: command.testGatePassed,
          everyCriterionHasTest: command.everyCriterionHasTest,
          hasCommits: command.hasCommits,
        }),
        outcome: () => ({ to: "verification" }),
      };
    case "submit_result":
      return {
        // From the first refinement or from implementation, with the agent alive.
        from: (t) => at("draft", "running")(t) || at("in_progress", "running")(t),
        outcome: () => ({ to: "completed" }),
      };
    case "verdict_rework": {
      const max = command.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      return {
        from: at("verification", "running"),
        guard: () => (isPositiveInt(max) ? undefined : "maxIterations must be a positive integer"),
        outcome: () =>
          iteration < max
            ? { to: "in_progress", iteration: iteration + 1 }
            : { to: "needs_human", reason: "iterations_exhausted" },
      };
    }
    case "verdict_pass":
      return {
        from: at("verification", "running"),
        guard: requireAll({
          verifierPassed: command.verifierPassed,
          testGatePassed: command.testGatePassed,
          testsCoherent: command.testsCoherent,
          allCriteriaPassed: command.allCriteriaPassed,
          prCreated: command.prCreated,
        }),
        outcome: () => ({ to: "completed" }),
      };
    case "delivery_conflict":
      return {
        // From completed: the open PR conflicted with the base after delivery
        // (another PR was merged first). It is the only exit from completed.
        from: (t) => at("verification", "running")(t) || at("completed", null)(t),
        outcome: () => ({ to: "in_progress" }),
      };
    case "escalate":
      return {
        from: (t) => !isTerminal(t.state) && t.state !== "needs_human" && t.state !== "paused",
        outcome: () => ({ to: "needs_human", reason: command.reason }),
      };
    case "cancel":
      return {
        from: (t) => !isTerminal(t.state),
        outcome: () => ({ to: "cancelled" }),
      };
    case "pause":
      return {
        from: (t) => PAUSABLE_STATES.includes(t.state),
        // Delivery (PR) runs with the verifier Run open: pausing it would leave it half done.
        guard: () =>
          task.state === "verification" && command.deliveryInProgress
            ? "delivery is in progress"
            : undefined,
        outcome: () => ({ to: "paused" }),
      };
    case "resume":
      return {
        from: (t) => at("needs_human", null)(t) || at("paused", null)(t),
        guard: () =>
          RESUMABLE_STATES.includes(command.resumeTo)
            ? undefined
            : `cannot resume to ${command.resumeTo}`,
        outcome: () =>
          command.resetIteration
            ? { to: command.resumeTo, iteration: 0 }
            : { to: command.resumeTo },
      };
    case "dispatch":
      return {
        from: inAgentState("queued"),
        outcome: () => ({ to: task.state, subState: "running" }),
      };
    case "ask_human":
      return {
        from: inAgentState("running"),
        outcome: () => ({ to: task.state, subState: "waiting_human" }),
      };
    case "answer":
      return {
        from: inAgentState("waiting_human"),
        outcome: () => ({ to: task.state, subState: command.agentAlive ? "running" : "queued" }),
      };
    case "run_failed": {
      const max = command.maxRetries ?? DEFAULT_MAX_RETRIES;
      return {
        from: inAgentState("running"),
        guard: () =>
          isPositiveInt(command.attempt) && isPositiveInt(max)
            ? undefined
            : "attempt and maxRetries must be positive integers",
        outcome: () =>
          command.attempt <= max
            ? { to: task.state, subState: "queued" }
            : { to: "needs_human", reason: "retries_exhausted" },
      };
    }
  }
}

/**
 * Applies a command to the task. It has no effects: it returns the next state and the event
 * that records it, or why it is rejected. Whoever persists writes both in the same transaction.
 */
export function transition(
  task: TaskSnapshot,
  command: CommandInput,
  actor: Actor,
): TransitionResult {
  const fail = (code: TransitionErrorCode, message: string): TransitionResult => ({
    ok: false,
    error: { code, message },
  });
  const r = rule(task, command);
  if (!isCoherent(task) || !r.from(task)) {
    return fail(
      "invalid_transition",
      `${command.type} does not apply from ${task.state}/${task.subState ?? "-"}`,
    );
  }
  if (!COMMAND_ACTORS[command.type].includes(actor)) {
    return fail("actor_not_allowed", `${actor} cannot emit ${command.type}`);
  }
  const guardError = r.guard?.();
  if (guardError) return fail("guard_failed", `${command.type}: ${guardError}`);

  const outcome = r.outcome();
  const next: TaskSnapshot = {
    state: outcome.to,
    subState: outcome.subState !== undefined ? outcome.subState : subStateFor(outcome.to),
    verificationIteration: outcome.iteration ?? task.verificationIteration,
  };
  const payload: TaskTransitionedPayload = {
    command: command.type,
    from: { state: task.state, subState: task.subState },
    to: { state: next.state, subState: next.subState },
    verificationIteration: next.verificationIteration,
  };
  if (outcome.reason) payload.reason = outcome.reason;
  if ("note" in command && command.note !== undefined) payload.note = command.note;
  // The Result type travels in the event note.
  if (command.type === "submit_result") payload.note = command.resultKind;
  // Validates the event against its schema: what enters the log must be readable later.
  const event = TaskTransitionedEvent.safeParse({ type: TASK_TRANSITIONED, actor, payload });
  if (!event.success) {
    return fail("guard_failed", `${command.type}: invalid event: ${event.error.message}`);
  }
  return { ok: true, next, event: event.data };
}
