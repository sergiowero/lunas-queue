// Escalations notified from the outbox (docs/design.md §Signals and §Human-in-the-loop,
// ADR uw-17-reconciliacion): exhausted retries and exhausted verification loop. They arrive through the
// transition to needs_human, whether it comes from a crash (dispatcher), `report_failure` or
// `submit_verdict` (LunasQ MCP), so there is a single place that notifies. The phase timeout is notified by
// the watcher directly. The id comes from the event: the outbox delivers at least once and the
// notification service's deduplication absorbs the repetition (ADR 0009).
import {
  type Notification,
  type OutboxMessage,
  TASK_TRANSITIONED,
  TaskTransitionedPayload,
  taskLabel,
} from "@lunasq/schemas";

/** `taskNumber` is the task number of the message: the title identifies it with #N. */
export function escalationNotification(
  taskNumber: number,
  message: OutboxMessage,
): Notification | null {
  if (message.topic !== TASK_TRANSITIONED || message.taskId === null) return null;
  const payload = TaskTransitionedPayload.safeParse(message.payload);
  if (!payload.success || payload.data.to.state !== "needs_human") return null;
  const short = taskLabel(taskNumber);
  const base = { taskId: message.taskId, createdAt: message.createdAt };
  switch (payload.data.reason) {
    case "retries_exhausted":
      return {
        ...base,
        id: `retries:${message.taskId}:${message.eventId}`,
        kind: "retries_exhausted",
        title: `Retries exhausted in ${short}`,
        body: `The ${payload.data.from.state} phase failed on all its retries. Check the last Run and resume or cancel the task.`,
      };
    case "iterations_exhausted":
      return {
        ...base,
        id: `iterations:${message.taskId}:${message.eventId}`,
        kind: "verification_exhausted",
        title: `Verification loop exhausted in ${short}`,
        body: `The task reached ${payload.data.verificationIteration} rework iterations without passing verification.`,
      };
    default:
      return null;
  }
}
