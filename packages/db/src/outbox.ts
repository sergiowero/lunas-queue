// Event outbox (docs/design.md §Components, ADR 0011): the row is written in the same
// transaction as its event, so a crash after the commit loses nothing. The publisher
// of @lunasq/server reads the pending ones in order and marks them when delivered.
import type { OutboxMessage } from "@lunasq/schemas";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import type { EventRow } from "./event-log.ts";
import { events, outbox } from "./schema.ts";

type Writer = Pick<LunasqDatabase, "insert">;

export type PendingOutboxEntry = { message: OutboxMessage; attempts: number };

/** Enqueues an already written event. Repeating it with the same event does not duplicate the row. */
export function enqueueOutbox(db: Writer, event: Pick<EventRow, "id" | "type">): void {
  db.insert(outbox)
    .values({ eventId: event.id, topic: event.type })
    .onConflictDoNothing({ target: outbox.eventId })
    .run();
}

/** Unpublished messages in write order, built from their event. */
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

/** Marks a message as published; returns false if it already was. */
export function markOutboxPublished(db: LunasqDatabase, id: number, at = new Date()): boolean {
  const result = db
    .update(outbox)
    .set({ publishedAt: at })
    .where(and(eq(outbox.id, id), isNull(outbox.publishedAt)))
    .run();
  return result.changes > 0;
}

/** Records a failed delivery and returns the accumulated attempts. */
export function recordOutboxFailure(db: LunasqDatabase, id: number): number {
  const row = db
    .update(outbox)
    .set({ attempts: sql`${outbox.attempts} + 1` })
    .where(eq(outbox.id, id))
    .returning({ attempts: outbox.attempts })
    .get();
  return row?.attempts ?? 0;
}
