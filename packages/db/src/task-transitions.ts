// Única vía para cambiar estado, sub-estado o iteración de una tarea (ADR 0007): aplica la
// máquina de estados de @lunasq/domain y escribe la tarea y su evento en una sola transacción.
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

/** Como CommandInput, pero resume toma su destino del último escalamiento registrado. */
export type TransitionCommand =
  | Exclude<CommandInput, { type: "resume" }>
  | Omit<Extract<CommandInput, { type: "resume" }>, "resumeTo">;

export type TransitionTaskInput = {
  taskId: string;
  actor: Actor;
  command: TransitionCommand;
  /** Estado que quien llama vio; si ya cambió, la transición se rechaza con stale_state. */
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

export function transitionTask(
  db: LunasqDatabase,
  input: TransitionTaskInput,
): TransitionTaskResult {
  // IMMEDIATE toma el lock de escritura antes de leer: otro proceso no puede mover la tarea
  // entre la lectura y el update.
  return db.transaction(
    (tx): TransitionTaskResult => {
      const fail = (code: TransitionTaskErrorCode, message: string): TransitionTaskResult => ({
        ok: false,
        error: { code, message },
      });
      const current = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
      if (!current) return fail("task_not_found", `no existe la tarea ${input.taskId}`);

      const { expected } = input;
      if (
        expected &&
        (expected.state !== current.state || expected.subState !== current.subState)
      ) {
        return fail(
          "stale_state",
          `se esperaba ${expected.state}/${expected.subState ?? "-"} y la tarea está en ${current.state}/${current.subState ?? "-"}`,
        );
      }

      let command: CommandInput;
      if (input.command.type === "resume") {
        // Fuera de needs_human resume se rechaza en el dominio; el destino no importa.
        const resumeTo =
          current.state === "needs_human" ? lastEscalationOrigin(tx, current.id) : current.state;
        if (!resumeTo) {
          return fail("no_escalation_found", `la tarea ${current.id} no tiene escalamiento`);
        }
        command = { ...input.command, resumeTo };
      } else {
        command = input.command;
      }

      const snapshot: TaskSnapshot = {
        state: current.state,
        subState: current.subState,
        verificationIteration: current.verificationIteration,
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
            current.subState === null
              ? isNull(tasks.subState)
              : eq(tasks.subState, current.subState),
          ),
        )
        .returning()
        .all();
      if (!task) throw new Error(`la tarea ${current.id} cambió durante la transición`);
      const event = appendEvent(tx, {
        taskId: task.id,
        type: result.event.type,
        actor: result.event.actor,
        payload: result.event.payload,
      });
      return { ok: true, task, event };
    },
    { behavior: "immediate" },
  );
}

/** Estado desde el que la tarea pasó a needs_human por última vez. */
function lastEscalationOrigin(tx: Pick<LunasqDatabase, "select">, taskId: string) {
  const row = tx
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.taskId, taskId),
        eq(events.type, TASK_TRANSITIONED),
        sql`json_extract(${events.payload}, '$.to.state') = 'needs_human'`,
      ),
    )
    .orderBy(desc(events.id))
    .limit(1)
    .get();
  return row ? TaskTransitionedPayload.parse(row.payload).from.state : undefined;
}
