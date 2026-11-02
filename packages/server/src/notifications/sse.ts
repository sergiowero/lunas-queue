// SSE stream of notifications to the UI. The event id is the notification's,
// so a reconnection with Last-Event-ID does not repeat what the browser already saw.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { NotificationHub } from "./hub.ts";

export function notificationRoutes(hub: NotificationHub): Hono {
  const app = new Hono();
  app.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      // Serializes writes to keep the publication order.
      let writes = Promise.resolve();
      const lastEventId = c.req.header("Last-Event-ID");
      const unsubscribe = hub.subscribe(
        (n) => {
          writes = writes
            .then(() =>
              stream.writeSSE({ event: "notification", id: n.id, data: JSON.stringify(n) }),
            )
            .catch(() => {});
        },
        lastEventId === undefined ? {} : { lastEventId },
      );
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsubscribe();
          resolve();
        });
      });
    }),
  );
  return app;
}
