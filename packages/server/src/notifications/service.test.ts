import { FakeHerdr } from "@lunasq/adapters";
import type { Notification } from "@lunasq/schemas";
import { describe, expect, it, vi } from "vitest";
import { NotificationHub } from "./hub.ts";
import {
  herdrChannel,
  hubChannel,
  type NotificationChannel,
  NotificationService,
} from "./service.ts";
import { notification } from "./test-helpers.ts";

function setup(opts: { notificationsEnabled?: boolean } = {}) {
  const herdr = new FakeHerdr({ notificationsEnabled: opts.notificationsEnabled ?? true });
  const hub = new NotificationHub();
  const ui: Notification[] = [];
  hub.subscribe((n) => ui.push(n));
  const onChannelError = vi.fn();
  const service = new NotificationService({
    channels: [herdrChannel(herdr), hubChannel(hub)],
    onChannelError,
  });
  return { herdr, hub, ui, service, onChannelError };
}

describe("NotificationService", () => {
  it("entrega una notificación una vez por herdr y una vez por la UI", async () => {
    const { herdr, ui, service } = setup();
    expect(await service.notify(notification())).toEqual({ delivered: true });
    expect(herdr.notifications).toEqual([
      {
        title: "Pregunta abierta en t-1",
        body: "El agente espera una respuesta",
        sound: "request",
      },
    ]);
    expect(ui.map((n) => n.id)).toEqual(["question:q-1"]);
  });

  it("el mismo id dos veces no duplica en ningún canal", async () => {
    const { herdr, ui, service } = setup();
    await service.notify(notification());
    expect(await service.notify(notification({ title: "otro título" }))).toEqual({
      delivered: false,
    });
    expect(herdr.notifications).toHaveLength(1);
    expect(ui).toHaveLength(1);
  });

  it("dos llamadas concurrentes con el mismo id entregan una sola vez", async () => {
    const { herdr, ui, service } = setup();
    await Promise.all([service.notify(notification()), service.notify(notification())]);
    expect(herdr.notifications).toHaveLength(1);
    expect(ui).toHaveLength(1);
  });

  it("con el toast de herdr apagado la UI la recibe y se reporta sin error", async () => {
    const { ui, service, onChannelError } = setup({ notificationsEnabled: false });
    await service.notify(notification());
    expect(ui).toHaveLength(1);
    expect(onChannelError).toHaveBeenCalledWith(
      "herdr",
      expect.objectContaining({ message: expect.stringContaining("disabled") }),
      expect.objectContaining({ id: "question:q-1" }),
    );
  });

  it("si un canal falla los demás reciben igual", async () => {
    const hub = new NotificationHub();
    const ui: Notification[] = [];
    hub.subscribe((n) => ui.push(n));
    const broken: NotificationChannel = {
      name: "roto",
      deliver: () => Promise.reject(new Error("herdr caído")),
    };
    const onChannelError = vi.fn();
    const service = new NotificationService({
      channels: [broken, hubChannel(hub)],
      onChannelError,
    });
    expect(await service.notify(notification())).toEqual({ delivered: true });
    expect(ui).toHaveLength(1);
    expect(onChannelError).toHaveBeenCalledWith(
      "roto",
      expect.any(Error),
      expect.objectContaining({ id: "question:q-1" }),
    );
  });

  it("si ningún canal entrega, el mismo id puede reintentarse", async () => {
    let fail = true;
    const flaky: NotificationChannel = {
      name: "inestable",
      deliver: () => (fail ? Promise.reject(new Error("caído")) : Promise.resolve()),
    };
    const service = new NotificationService({ channels: [flaky], onChannelError: vi.fn() });
    expect(await service.notify(notification())).toEqual({ delivered: false });
    fail = false;
    expect(await service.notify(notification())).toEqual({ delivered: true });
    expect(await service.notify(notification())).toEqual({ delivered: false });
  });

  it("rechaza una notificación inválida sin entregar nada", async () => {
    const { herdr, ui, service } = setup();
    await expect(service.notify(notification({ id: "" }))).rejects.toThrow();
    expect(herdr.notifications).toHaveLength(0);
    expect(ui).toHaveLength(0);
  });
});
