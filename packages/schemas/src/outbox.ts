// Mensaje que el publicador del outbox entrega al scheduler y al dispatcher (docs/design.md
// §Componentes, ADR 0010). Se arma desde el evento del Event log; el payload es el del evento
// y cada suscriptor lo valida con el esquema de su topic (p. ej. TaskTransitionedPayload).
import { z } from "zod";
import { Actor } from "./enums.ts";
import { EntityId } from "./handoff/common.ts";

export const OutboxMessage = z.strictObject({
  id: z.int().positive(),
  eventId: z.int().positive(),
  topic: z.string().min(1),
  taskId: EntityId,
  actor: Actor,
  payload: z.unknown(),
  createdAt: z.iso.datetime(),
});
export type OutboxMessage = z.infer<typeof OutboxMessage>;
