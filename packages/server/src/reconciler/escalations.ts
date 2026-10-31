// Escalamientos que se notifican desde el outbox (docs/design.md §Señales y §Human-in-the-loop,
// ADR uw-17-reconciliacion): reintentos agotados y loop de verificación agotado. Llegan por la
// transición a needs_human, venga de un crash (dispatcher), de `report_failure` o de
// `submit_verdict` (LunasQ MCP), así hay un solo lugar que avisa. El timeout de fase lo notifica
// el watcher directamente. El id sale del evento: el outbox entrega al menos una vez y la
// deduplicación del servicio de notificaciones absorbe la repetición (ADR 0009).
import {
  type Notification,
  type OutboxMessage,
  TASK_TRANSITIONED,
  TaskTransitionedPayload,
  taskLabel,
} from "@lunasq/schemas";

/** `taskNumber` es el número de la tarea del mensaje: el título la identifica con #N. */
export function escalationNotification(
  taskNumber: number,
  message: OutboxMessage,
): Notification | null {
  if (message.topic !== TASK_TRANSITIONED) return null;
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
        title: `Reintentos agotados en ${short}`,
        body: `La fase de ${payload.data.from.state} falló en todos sus reintentos. Revisa el último Run y reanuda o cancela la tarea.`,
      };
    case "iterations_exhausted":
      return {
        ...base,
        id: `iterations:${message.taskId}:${message.eventId}`,
        kind: "verification_exhausted",
        title: `Loop de verificación agotado en ${short}`,
        body: `La tarea llegó a ${payload.data.verificationIteration} iteraciones de rework sin pasar la verificación.`,
      };
    default:
      return null;
  }
}
