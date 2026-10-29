// Event log append-only (docs/design.md §Auditoría, ADR 0007). Los triggers de la migración
// 0001 impiden modificar o borrar eventos; aquí solo se agregan y se leen.
import type { Actor } from "@lunasq/schemas";
import { asc, eq } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { enqueueOutbox } from "./outbox.ts";
import { events } from "./schema.ts";

export type EventRow = typeof events.$inferSelect;

// También acepta la transacción de Drizzle, que expone los mismos builders.
type Writer = Pick<LunasqDatabase, "insert" | "transaction">;
type Reader = Pick<LunasqDatabase, "select">;

export type AppendEventInput = {
  taskId: string;
  type: string;
  actor: Actor;
  payload?: unknown;
};

/**
 * Con `publish` el evento también entra al outbox (ADR 0010), en la misma transacción: dentro
 * de otra transacción es un savepoint, así que falla o se confirma junto con quien llama.
 */
export function appendEvent(
  db: Writer,
  input: AppendEventInput,
  opts: { publish?: boolean } = {},
): EventRow {
  return db.transaction((tx) => {
    const [row] = tx.insert(events).values(input).returning().all();
    if (!row) throw new Error("insert de evento sin fila");
    if (opts.publish) enqueueOutbox(tx, row);
    return row;
  });
}

/** Eventos de una tarea en orden de escritura. */
export function listEvents(db: Reader, taskId: string): EventRow[] {
  return db.select().from(events).where(eq(events.taskId, taskId)).orderBy(asc(events.id)).all();
}
