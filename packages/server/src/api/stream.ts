// Stream SSE de cambios para la UI (UW-21, ADR uw-21-front-end). Cada cambio de una tarea deja un
// evento en el Event log, así que el stream sigue el id del último evento: con eventos nuevos manda
// `change` con las tareas afectadas y el front end invalida esas consultas. El id del mensaje es
// el del evento, así una reconexión con Last-Event-ID recupera lo que se perdió.
import type { TaskViewRepository } from "@lunasq/db";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export const DEFAULT_CHANGE_STREAM_INTERVAL_MS = 500;

function cursor(header: string | undefined, views: TaskViewRepository): number {
  const parsed = header === undefined ? Number.NaN : Number(header);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : views.lastEventId();
}

export function changeStreamRoutes(views: TaskViewRepository, intervalMs: number): Hono {
  return new Hono().get("/", (c) =>
    streamSSE(c, async (stream) => {
      let after = cursor(c.req.header("Last-Event-ID"), views);
      while (!stream.aborted && !stream.closed) {
        const { lastId, taskIds } = views.changesSince(after);
        if (taskIds.length > 0) {
          await stream.writeSSE({
            event: "change",
            id: String(lastId),
            data: JSON.stringify({ taskIds }),
          });
        }
        after = lastId;
        await stream.sleep(intervalMs);
      }
    }),
  );
}
