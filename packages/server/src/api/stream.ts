// SSE change stream for the UI (ADR uw-21-front-end). Each task change leaves an
// event in the Event log, so the stream follows the id of the last event: with new events it sends
// `change` with the affected tasks and the front end invalidates those queries. The message id is
// the event's, so a reconnection with Last-Event-ID recovers what was lost.
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
        const { lastId, taskIds, settingsChanged } = views.changesSince(after);
        if (taskIds.length > 0 || settingsChanged) {
          await stream.writeSSE({
            event: "change",
            id: String(lastId),
            // `settings` only travels when the global configuration changed (settings.updated).
            data: JSON.stringify(settingsChanged ? { taskIds, settings: true } : { taskIds }),
          });
        }
        after = lastId;
        await stream.sleep(intervalMs);
      }
    }),
  );
}
