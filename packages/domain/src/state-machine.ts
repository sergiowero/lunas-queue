// Máquina de estados de la tarea (docs/design.md §Máquina de estados, ADR 0007).
// TypeScript puro: los guards reciben hechos ya calculados por quien llama (gate de tests,
// spec aprobada, veredicto), así el dominio no conoce base de datos, herdr ni gh.
import {
  type Actor,
  type EscalationReason,
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
  | { type: "verdict_rework"; maxIterations?: number }
  | {
      type: "verdict_pass";
      // Veredicto pass registrado por el Run del verificador en la iteración actual.
      verifierPassed: boolean;
      testGatePassed: boolean;
      testsCoherent: boolean;
      allCriteriaPassed: boolean;
      prCreated: boolean;
    }
  | { type: "delivery_conflict" }
  | { type: "escalate"; reason: EscalationReason; note?: string }
  | { type: "cancel"; note?: string }
  // resetIteration: el humano concede un nuevo ciclo de verificación completo.
  | { type: "resume"; resumeTo: TaskState; resetIteration?: boolean }
  | { type: "dispatch" }
  | { type: "ask_human" }
  | { type: "answer"; agentAlive: boolean }
  // attempt: Runs fallidos consecutivos en la fase, contando este.
  | { type: "run_failed"; attempt: number; maxRetries?: number };

export type TransitionErrorCode = "invalid_transition" | "actor_not_allowed" | "guard_failed";

export type TransitionResult =
  | { ok: true; next: TaskSnapshot; event: TaskTransitionedEvent }
  | { ok: false; error: { code: TransitionErrorCode; message: string } };

/** Quién puede emitir cada comando (tabla de transiciones del diseño). */
export const COMMAND_ACTORS: Readonly<Record<TaskCommand, readonly Actor[]>> = {
  submit_spec: ["agent"],
  request_changes: ["human"],
  approve: ["human"],
  submit_for_verification: ["agent"],
  verdict_rework: ["agent"],
  // El verificador registra su veredicto en el handoff; la entrega emite el pass tras el PR.
  verdict_pass: ["system"],
  delivery_conflict: ["system"],
  escalate: ["system"],
  cancel: ["human"],
  resume: ["human"],
  dispatch: ["system"],
  ask_human: ["agent"],
  answer: ["human"],
  run_failed: ["system"],
};

const AGENT_STATES: readonly TaskState[] = ["draft", "in_progress", "verification"];
const TERMINAL_STATES: readonly TaskState[] = ["completed", "cancelled"];
const RESUMABLE_STATES: readonly TaskState[] = ["draft", "refined", "in_progress", "verification"];

/** Sub-estado con el que se entra a un estado: queued si lleva agente, null si no. */
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
  // Orígenes (estado y sub-estado) desde los que aplica el comando.
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
    case "verdict_rework": {
      const max = command.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      return {
        from: at("verification", "running"),
        guard: () => (isPositiveInt(max) ? undefined : "maxIterations debe ser entero positivo"),
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
        // Desde completed: el PR abierto quedó en conflicto con la base después de entregarse
        // (otro PR se mergeó antes). Es la única salida de completed.
        from: (t) => at("verification", "running")(t) || at("completed", null)(t),
        outcome: () => ({ to: "in_progress" }),
      };
    case "escalate":
      return {
        from: (t) => !isTerminal(t.state) && t.state !== "needs_human",
        outcome: () => ({ to: "needs_human", reason: command.reason }),
      };
    case "cancel":
      return {
        from: (t) => !isTerminal(t.state),
        outcome: () => ({ to: "cancelled" }),
      };
    case "resume":
      return {
        from: at("needs_human", null),
        guard: () =>
          RESUMABLE_STATES.includes(command.resumeTo)
            ? undefined
            : `no se puede reanudar hacia ${command.resumeTo}`,
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
            : "attempt y maxRetries deben ser enteros positivos",
        outcome: () =>
          command.attempt <= max
            ? { to: task.state, subState: "queued" }
            : { to: "needs_human", reason: "retries_exhausted" },
      };
    }
  }
}

/**
 * Aplica un comando a la tarea. No tiene efectos: devuelve el estado siguiente y el evento
 * que lo registra, o por qué se rechaza. Quien persiste escribe ambos en la misma transacción.
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
      `${command.type} no aplica desde ${task.state}/${task.subState ?? "-"}`,
    );
  }
  if (!COMMAND_ACTORS[command.type].includes(actor)) {
    return fail("actor_not_allowed", `${actor} no puede emitir ${command.type}`);
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
  // Valida el evento contra su esquema: lo que entra al log debe poder leerse después.
  const event = TaskTransitionedEvent.safeParse({ type: TASK_TRANSITIONED, actor, payload });
  if (!event.success) {
    return fail("guard_failed", `${command.type}: evento inválido: ${event.error.message}`);
  }
  return { ok: true, next, event: event.data };
}
