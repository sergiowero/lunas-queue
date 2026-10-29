// Stream SSE de notificaciones hacia la UI. El id del evento es el de la notificación,
// así una reconexión con Last-Event-ID no repite lo que el navegador ya vio.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { NotificationHub } from "./hub.ts";

export function notificationRoutes(hub: NotificationHub): Hono {
  const app = new Hono();
  app.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      // Serializa las escrituras para conservar el orden de publicación.
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
