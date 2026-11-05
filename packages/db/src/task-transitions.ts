// The only way to change a task's state, sub-state or iteration (ADR 0007): it applies the
// state machine of @lunasq/domain and writes the task and its event in a single transaction.
import {
  type CommandInput,
  type TaskSnapshot,
  type TransitionErrorCode,
  transition,
} from "@lunasq/domain";
import {
  type Actor,
  type StatePosition,
  TASK_TRANSITIONED,
  TaskTransitionedPayload,
} from "@lunasq/schemas";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent, type EventRow } from "./event-log.ts";
import { events, tasks } from "./schema.ts";

export type TaskRow = typeof tasks.$inferSelect;

/** Like CommandInput, but resume takes its destination from the last recorded escalation or pause. */
export type TransitionCommand =
  | Exclude<CommandInput, { type: "resume" }>
  | Omit<Extract<CommandInput, { type: "resume" }>, "resumeTo">;

export type TransitionTaskInput = {
  taskId: string;
  actor: Actor;
  command: TransitionCommand;
  /** State the caller saw; if it already changed, the transition is rejected with stale_state. */
  expected?: StatePosition;
};

export type TransitionTaskErrorCode =
  | TransitionErrorCode
  | "task_not_found"
  | "stale_state"
  | "no_escalation_found";

export type TransitionTaskResult =
  | { ok: true; task: TaskRow; event: EventRow }
  | { ok: false; error: { code: TransitionTaskErrorCode; message: string } };

export type Tx = Parameters<Parameters<LunasqDatabase["transaction"]>[0]>[0];

export function transitionTask(
  db: LunasqDatabase,
  input: TransitionTaskInput,
): TransitionTaskResult {
  // IMMEDIATE takes the write lock before reading: another process cannot move the task
  // between the read and the update.
  return db.transaction((tx) => applyTransition(tx, input), { behavior: "immediate" });
}

/**
 * Like transitionTask, inside an IMMEDIATE transaction already opened by the caller: this way its own
 * write (for example the spec version, ADR 0013) and the transition are confirmed
 * together. A rejection writes nothing; the caller decides whether to roll back its own.
 */
export function applyTransition(tx: Tx, input: TransitionTaskInput): TransitionTaskResult {
  const fail = (code: TransitionTaskErrorCode, message: string): TransitionTaskResult => ({
    ok: false,
    error: { code, message },
  });
  const current = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
  if (!current) return fail("task_not_found", `task ${input.taskId} does not exist`);

  const { expected } = input;
  if (expected && (expected.state !== current.state || expected.subState !== current.subState)) {
    return fail(
      "stale_state",
      `expected ${expected.state}/${expected.subState ?? "-"} but the task is in ${current.state}/${current.subState ?? "-"}`,
    );
  }

  let command: CommandInput;
  if (input.command.type === "resume") {
    // Outside needs_human and paused, resume is rejected in the domain; the destination does not matter.
    const origin =
      current.state === "needs_human" || current.state === "paused"
        ? lastOrigin(tx, current.id, current.state)
        : undefined;
    if ((current.state === "needs_human" || current.state === "paused") && !origin) {
      return fail(
        "no_escalation_found",
        `task ${current.id} has no event that took it to ${current.state}`,
      );
    }
    // Exhausted iterations in verification: there is an unfixed must-fix. Resuming to verification
    // would verify the same unchanged diff again and escalate again; the destination is implement.
    // And since the human resumes so the agent fixes it, a new cycle of iterations starts at the
    // current one (newCycle); the cumulative iteration is kept. Otherwise, the first reject would
    // escalate again at once.
    const exhausted =
      origin !== undefined &&
      origin.from === "verification" &&
      origin.reason === "iterations_exhausted";
    const resumeTo = exhausted ? "in_progress" : (origin?.from ?? current.state);
    command = exhausted
      ? { ...input.command, resumeTo, newCycle: true }
      : { ...input.command, resumeTo };
  } else {
    command = input.command;
  }

  const snapshot: TaskSnapshot = {
    state: current.state,
    subState: current.subState,
    verificationIteration: current.verificationIteration,
    verificationCycleStart: current.verificationCycleStart,
  };
  const result = transition(snapshot, command, input.actor);
  if (!result.ok) return result;

  const [task] = tx
    .update(tasks)
    .set(result.next)
    .where(
      and(
        eq(tasks.id, current.id),
        eq(tasks.state, current.state),
        current.subState === null ? isNull(tasks.subState) : eq(tasks.subState, current.subState),
      ),
    )
    .returning()
    .all();
  if (!task) throw new Error(`task ${current.id} changed during the transition`);
  const event = appendEvent(
    tx,
    {
      taskId: task.id,
      type: result.event.type,
      actor: result.event.actor,
      payload: result.event.payload,
    },
    { publish: true },
  );
  return { ok: true, task, event };
}

/** State from which the task last moved to `entered` (needs_human or paused), and the reason. */
function lastOrigin(
  tx: Pick<LunasqDatabase, "select">,
  taskId: string,
  entered: "needs_human" | "paused",
) {
  const row = tx
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.taskId, taskId),
        eq(events.type, TASK_TRANSITIONED),
        sql`json_extract(${events.payload}, '$.to.state') = ${entered}`,
      ),
    )
    .orderBy(desc(events.id))
    .limit(1)
    .get();
  if (!row) return undefined;
  const payload = TaskTransitionedPayload.parse(row.payload);
  return { from: payload.from.state, reason: payload.reason };
}
