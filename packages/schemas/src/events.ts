// Eventos del Event log (docs/design.md §Máquina de estados y §Auditoría).
// task.transitioned es el único evento que cambia estado; ADR 0007 fija su forma.
import { z } from "zod";
import { Actor, SubState, TaskState } from "./enums.ts";

/** Comandos de la máquina de estados: los primeros mueven el estado, los últimos el sub-estado. */
export const TaskCommand = z.enum([
  "submit_spec",
  "request_changes",
  "approve",
  "submit_for_verification",
  "verdict_rework",
  "verdict_pass",
  "delivery_conflict",
  "escalate",
  "cancel",
  "resume",
  "dispatch",
  "ask_human",
  "answer",
  "run_failed",
]);
export type TaskCommand = z.infer<typeof TaskCommand>;

/** Por qué una tarea pasó a needs_human (§Human-in-the-loop, puntos de escalamiento). */
export const EscalationReason = z.enum([
  "blocked",
  "phase_timeout",
  "retries_exhausted",
  "iterations_exhausted",
  "hook_failed",
  "dependency_pr_closed",
  "delivery_failed",
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

export const StatePosition = z.strictObject({
  state: TaskState,
  subState: SubState.nullable(),
});
export type StatePosition = z.infer<typeof StatePosition>;

export const TASK_TRANSITIONED = "task.transitioned";

export const TaskTransitionedPayload = z.strictObject({
  command: TaskCommand,
  from: StatePosition,
  to: StatePosition,
  // Iteración de verificación después de la transición.
  verificationIteration: z.int().min(0),
  reason: EscalationReason.optional(),
  note: z.string().min(1).max(2000).optional(),
});
export type TaskTransitionedPayload = z.infer<typeof TaskTransitionedPayload>;

export const TaskTransitionedEvent = z.strictObject({
  type: z.literal(TASK_TRANSITIONED),
  actor: Actor,
  payload: TaskTransitionedPayload,
});
export type TaskTransitionedEvent = z.infer<typeof TaskTransitionedEvent>;
