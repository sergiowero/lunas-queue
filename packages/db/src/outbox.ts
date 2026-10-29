// Outbox de eventos (docs/design.md §Componentes, ADR 0010): la fila se escribe en la misma
// transacción que su evento, así una caída después del commit no pierde nada. El publicador
// de @lunasq/server lee los pendientes en orden y los marca al entregarlos.
import type { OutboxMessage } from "@lunasq/schemas";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import type { EventRow } from "./event-log.ts";
import { events, outbox } from "./schema.ts";

type Writer = Pick<LunasqDatabase, "insert">;

export type PendingOutboxEntry = { message: OutboxMessage; attempts: number };

/** Encola un evento ya escrito. Repetirlo con el mismo evento no duplica la fila. */
export function enqueueOutbox(db: Writer, event: Pick<EventRow, "id" | "type">): void {
  db.insert(outbox)
    .values({ eventId: event.id, topic: event.type })
    .onConflictDoNothing({ target: outbox.eventId })
    .run();
}

/** Mensajes sin publicar en orden de escritura, armados desde su evento. */
export function listPendingOutbox(
  db: LunasqDatabase,
  opts: { limit?: number } = {},
): PendingOutboxEntry[] {
  const rows = db
    .select({
      id: outbox.id,
      eventId: outbox.eventId,
      topic: outbox.topic,
      attempts: outbox.attempts,
      taskId: events.taskId,
      actor: events.actor,
      payload: events.payload,
      createdAt: events.createdAt,
    })
    .from(outbox)
    .innerJoin(events, eq(events.id, outbox.eventId))
    .where(isNull(outbox.publishedAt))
    .orderBy(asc(outbox.id))
    .limit(opts.limit ?? 100)
    .all();
  return rows.map(({ attempts, createdAt, payload, ...rest }) => ({
    attempts,
    message: { ...rest, payload: payload ?? null, createdAt: createdAt.toISOString() },
  }));
}

/** Marca un mensaje como publicado; devuelve false si ya lo estaba. */
export function markOutboxPublished(db: LunasqDatabase, id: number, at = new Date()): boolean {
  const result = db
    .update(outbox)
    .set({ publishedAt: at })
    .where(and(eq(outbox.id, id), isNull(outbox.publishedAt)))
    .run();
  return result.changes > 0;
}

/** Registra una entrega fallida y devuelve los intentos acumulados. */
export function recordOutboxFailure(db: LunasqDatabase, id: number): number {
  const row = db
    .update(outbox)
    .set({ attempts: sql`${outbox.attempts} + 1` })
    .where(eq(outbox.id, id))
    .returning({ attempts: outbox.attempts })
    .get();
  return row?.attempts ?? 0;
}
