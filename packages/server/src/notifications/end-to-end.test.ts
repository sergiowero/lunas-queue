// Criterio de terminado de UW-06: una notificación llega por ambos canales sin duplicarse.
import { FakeHerdr } from "@lunasq/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotifications } from "./index.ts";
import { notification, readSseEvents } from "./test-helpers.ts";

describe("notificaciones de punta a punta", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("una pregunta abierta 1 minuto llega una vez por herdr y una vez por SSE", async () => {
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
    // Vigilar de nuevo (p. ej. una señal repetida) y notificar directo no duplican nada.
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

  it("un aviso directo antes del escalamiento tampoco se duplica", async () => {
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

  it("los errores del escalador llegan al handler inyectado", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const onEscalationError = vi.fn();
    const notifications = createNotifications({
      herdr: new FakeHerdr(),
      onChannelError: () => {},
      onEscalationError,
    });
    // Un id inválido pasa el watch (no valida) y falla al notificar: el servicio lo rechaza.
    const { createdAt: _, ...pending } = notification({ id: "id inválido" });
    notifications.escalator.watch(pending);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onEscalationError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ id: "id inválido" }),
    );
  });
});
