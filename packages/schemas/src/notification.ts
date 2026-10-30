// Notificaciones al humano (docs/design.md §Señales y §Human-in-the-loop): las cuatro
// situaciones de escalamiento, más los reintentos agotados. El id es determinístico y es la clave de deduplicación
// en todos los canales (toast de herdr y SSE hacia la UI).
import { z } from "zod";
import { EntityId, ShortText, Text } from "./handoff/common.ts";

export const NotificationKind = z.enum([
  "question_open",
  "agent_blocked",
  "phase_timeout",
  "verification_exhausted",
  // Run fallido tras agotar los reintentos de la fase (ADR uw-17-reconciliacion).
  "retries_exhausted",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const NotificationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/, {
  error:
    "id de notificación inválido: se esperan de 1 a 128 caracteres alfanuméricos, guion, guion bajo o dos puntos",
});

export const Notification = z.strictObject({
  id: NotificationId,
  kind: NotificationKind,
  taskId: EntityId,
  runId: EntityId.optional(),
  title: ShortText,
  body: Text,
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof Notification>;
