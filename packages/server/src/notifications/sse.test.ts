import { describe, expect, it } from "vitest";
import { NotificationHub } from "./hub.ts";
import { notificationRoutes } from "./sse.ts";
import { notification, readSseEvents } from "./test-helpers.ts";

async function open(hub: NotificationHub, headers: Record<string, string> = {}) {
  const res = await notificationRoutes(hub).request("/stream", { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  if (!res.body) throw new Error("sin body");
  return res.body;
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(cond()).toBe(true);
}

describe("GET /stream (SSE de notificaciones)", () => {
  it("emite cada notificación como evento con su id", async () => {
    const hub = new NotificationHub();
    const body = await open(hub);
    await until(() => hub.subscriberCount === 1);
    hub.publish(notification());
    const { events, cancel } = await readSseEvents(body, 1);
    await cancel();
    expect(events).toEqual([
      { event: "notification", id: "question:q-1", data: JSON.stringify(notification()) },
    ]);
  });

  it("al reconectar con Last-Event-ID no repite lo ya visto", async () => {
    const hub = new NotificationHub();
    hub.publish(notification({ id: "n:1" }));
    hub.publish(notification({ id: "n:2" }));
    const body = await open(hub, { "Last-Event-ID": "n:1" });
    await until(() => hub.subscriberCount === 1);
    hub.publish(notification({ id: "n:3" }));
    const { events, cancel } = await readSseEvents(body, 2);
    await cancel();
    expect(events.map((e) => e.id)).toEqual(["n:2", "n:3"]);
  });

  it("cerrar la conexión libera la suscripción", async () => {
    const hub = new NotificationHub();
    const body = await open(hub);
    await until(() => hub.subscriberCount === 1);
    await body.cancel();
    await until(() => hub.subscriberCount === 0);
  });
});
