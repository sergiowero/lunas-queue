// Event log events (docs/design.md §State machine and §Audit).
// task.transitioned is the only event that changes state; ADR 0007 fixes its shape.
import { z } from "zod";
import { Actor, SubState, TaskState } from "./enums.ts";

/** State machine commands: the first ones move the state, the last ones the sub-state. */
export const TaskCommand = z.enum([
  "submit_spec",
  "request_changes",
  "approve",
  "submit_for_verification",
  "submit_result",
  "verdict_rework",
  "verdict_pass",
  "delivery_conflict",
  "escalate",
  "cancel",
  "pause",
  "resume",
  "dispatch",
  "ask_human",
  "answer",
  "run_failed",
]);
export type TaskCommand = z.infer<typeof TaskCommand>;

/** Why a task moved to needs_human (§Human-in-the-loop, escalation points). */
export const EscalationReason = z.enum([
  "blocked",
  "phase_timeout",
  "usage_limit",
  "retries_exhausted",
  "iterations_exhausted",
  "hook_failed",
  "dependency_pr_closed",
  "delivery_failed",
  "providers_unavailable",
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
  // Verification iteration after the transition.
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
