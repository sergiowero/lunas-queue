// Append-only Event log (docs/design.md §Audit, ADR 0007). The triggers of migration
// 0001 prevent modifying or deleting events; here they are only appended and read.
import type { Actor } from "@lunasq/schemas";
import { asc, eq } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { enqueueOutbox } from "./outbox.ts";
import { events } from "./schema.ts";

export type EventRow = typeof events.$inferSelect;

// It also accepts the Drizzle transaction, which exposes the same builders.
type Writer = Pick<LunasqDatabase, "insert" | "transaction">;
type Reader = Pick<LunasqDatabase, "select">;

export type AppendEventInput = {
  /** Null on global events (settings.updated), which do not belong to a task. */
  taskId: string | null;
  type: string;
  actor: Actor;
  payload?: unknown;
};

/**
 * With `publish` the event also enters the outbox (ADR 0011), in the same transaction: inside
 * another transaction it is a savepoint, so it fails or commits together with the caller.
 */
export function appendEvent(
  db: Writer,
  input: AppendEventInput,
  opts: { publish?: boolean } = {},
): EventRow {
  return db.transaction((tx) => {
    const [row] = tx.insert(events).values(input).returning().all();
    if (!row) throw new Error("event insert without a row");
    if (opts.publish) enqueueOutbox(tx, row);
    return row;
  });
}

/** Events of a task in write order. */
export function listEvents(db: Reader, taskId: string): EventRow[] {
  return db.select().from(events).where(eq(events.taskId, taskId)).orderBy(asc(events.id)).all();
}
