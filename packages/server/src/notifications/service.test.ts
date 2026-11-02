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
  it("delivers a notification once through herdr and once through the UI", async () => {
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

  it("the same id twice does not duplicate on any channel", async () => {
    const { herdr, ui, service } = setup();
    await service.notify(notification());
    expect(await service.notify(notification({ title: "otro título" }))).toEqual({
      delivered: false,
    });
    expect(herdr.notifications).toHaveLength(1);
    expect(ui).toHaveLength(1);
  });

  it("two concurrent calls with the same id deliver only once", async () => {
    const { herdr, ui, service } = setup();
    await Promise.all([service.notify(notification()), service.notify(notification())]);
    expect(herdr.notifications).toHaveLength(1);
    expect(ui).toHaveLength(1);
  });

  it("with herdr's toast off the UI receives it and it is reported without error", async () => {
    const { ui, service, onChannelError } = setup({ notificationsEnabled: false });
    await service.notify(notification());
    expect(ui).toHaveLength(1);
    expect(onChannelError).toHaveBeenCalledWith(
      "herdr",
      expect.objectContaining({ message: expect.stringContaining("disabled") }),
      expect.objectContaining({ id: "question:q-1" }),
    );
  });

  it("if one channel fails the others still receive", async () => {
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

  it("if no channel delivers, the same id can be retried", async () => {
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

  it("rejects an invalid notification without delivering anything", async () => {
    const { herdr, ui, service } = setup();
    await expect(service.notify(notification({ id: "" }))).rejects.toThrow();
    expect(herdr.notifications).toHaveLength(0);
    expect(ui).toHaveLength(0);
  });
});
