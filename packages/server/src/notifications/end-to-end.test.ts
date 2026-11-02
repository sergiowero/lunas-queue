// UW-06 done criterion: a notification arrives through both channels without duplicating.
import { FakeHerdr } from "@lunasq/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotifications } from "./index.ts";
import { notification, readSseEvents } from "./test-helpers.ts";

describe("end-to-end notifications", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a question open for 1 minute arrives once through herdr and once through SSE", async () => {
    vi.useFakeTimers({
      now: new Date("2026-10-29T12:00:00.000Z"),
      toFake: ["setTimeout", "clearTimeout", "Date"],
    });
    const herdr = new FakeHerdr({ notificationsEnabled: true });
    const notifications = createNotifications({ herdr });

    const res = await notifications.routes.request("/stream");
    if (!res.body) throw new Error("sin body");
    const { createdAt: _, ...pending } = notification();

    notifications.escalator.watch(pending);
    // Watching again (e.g. a repeated signal) and notifying directly duplicate nothing.
    notifications.escalator.watch(pending);
    await vi.advanceTimersByTimeAsync(60_000);
    await notifications.service.notify({ ...pending, createdAt: new Date().toISOString() });
    notifications.hub.publish(notification({ id: "marca:fin" }));

    vi.useRealTimers();
    const { events, cancel } = await readSseEvents(res.body, 2);
    await cancel();

    expect(events.map((e) => e.id)).toEqual(["question:q-1", "marca:fin"]);
    expect(JSON.parse(events[0]?.data ?? "")).toMatchObject({
      id: "question:q-1",
      createdAt: "2026-10-29T12:01:00.000Z",
    });
    expect(herdr.notifications).toEqual([
      { title: pending.title, body: pending.body, sound: "request" },
    ]);
  });

  it("a direct notice before escalation is not duplicated either", async () => {
    vi.useFakeTimers({
      now: new Date("2026-10-29T12:00:00.000Z"),
      toFake: ["setTimeout", "clearTimeout", "Date"],
    });
    const herdr = new FakeHerdr({ notificationsEnabled: true });
    const notifications = createNotifications({ herdr });

    const res = await notifications.routes.request("/stream");
    if (!res.body) throw new Error("sin body");
    const { createdAt: _, ...pending } = notification();

    await notifications.service.notify({ ...pending, createdAt: new Date().toISOString() });
    notifications.escalator.watch(pending);
    await vi.advanceTimersByTimeAsync(60_000);
    notifications.hub.publish(notification({ id: "marca:fin" }));

    vi.useRealTimers();
    const { events, cancel } = await readSseEvents(res.body, 2);
    await cancel();

    expect(events.map((e) => e.id)).toEqual(["question:q-1", "marca:fin"]);
    expect(herdr.notifications).toHaveLength(1);
  });

  it("the escalator's errors reach the injected handler", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const onEscalationError = vi.fn();
    const notifications = createNotifications({
      herdr: new FakeHerdr(),
      onChannelError: () => {},
      onEscalationError,
    });
    // An invalid id passes watch (it does not validate) and fails on notify: the service rejects it.
    const { createdAt: _, ...pending } = notification({ id: "id inválido" });
    notifications.escalator.watch(pending);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onEscalationError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ id: "id inválido" }),
    );
  });
});
