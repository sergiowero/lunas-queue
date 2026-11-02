// Message that the outbox publisher delivers to the scheduler and the dispatcher (docs/design.md
// §Components, ADR 0011). It is built from the Event log event; the payload is the event's
// and each subscriber validates it with the schema of its topic (e.g. TaskTransitionedPayload).
import { z } from "zod";
import { Actor } from "./enums.ts";
import { EntityId } from "./handoff/common.ts";

export const OutboxMessage = z.strictObject({
  id: z.int().positive(),
  eventId: z.int().positive(),
  topic: z.string().min(1),
  // Null on global events (settings.updated).
  taskId: EntityId.nullable(),
  actor: Actor,
  payload: z.unknown(),
  createdAt: z.iso.datetime(),
});
export type OutboxMessage = z.infer<typeof OutboxMessage>;
