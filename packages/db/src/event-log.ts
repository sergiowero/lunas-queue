// Event log append-only (docs/design.md §Auditoría, ADR 0007). Los triggers de la migración
// 0001 impiden modificar o borrar eventos; aquí solo se agregan y se leen.
import type { Actor } from "@lunasq/schemas";
import { asc, eq } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { events } from "./schema.ts";

export type EventRow = typeof events.$inferSelect;

// También acepta la transacción de Drizzle, que expone los mismos builders.
type Writer = Pick<LunasqDatabase, "insert">;
type Reader = Pick<LunasqDatabase, "select">;

export type AppendEventInput = {
  taskId: string;
  type: string;
  actor: Actor;
  payload?: unknown;
};

export function appendEvent(db: Writer, input: AppendEventInput): EventRow {
  const [row] = db.insert(events).values(input).returning().all();
  if (!row) throw new Error("insert de evento sin fila");
  return row;
}

/** Eventos de una tarea en orden de escritura. */
export function listEvents(db: Reader, taskId: string): EventRow[] {
  return db.select().from(events).where(eq(events.taskId, taskId)).orderBy(asc(events.id)).all();
}
