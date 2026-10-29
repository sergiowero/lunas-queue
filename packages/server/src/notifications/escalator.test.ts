import type { Notification } from "@lunasq/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESCALATION_DELAY_MS, Escalator } from "./escalator.ts";
import { notification } from "./test-helpers.ts";

const { createdAt: _, ...pending } = notification();

describe("Escalator", () => {
  let sent: Notification[];
  let escalator: Escalator;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-29T12:00:00.000Z") });
    sent = [];
    escalator = new Escalator({ notify: (n) => void sent.push(n) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("escala a 1 minuto por defecto", () => {
    expect(ESCALATION_DELAY_MS).toBe(60_000);
  });

  it("no notifica antes del minuto y sí al cumplirse", () => {
    escalator.watch(pending);
    vi.advanceTimersByTime(59_999);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ ...pending, createdAt: "2026-10-29T12:01:00.000Z" }]);
    expect(escalator.pending()).toEqual([]);
  });

  it("resolver antes del minuto cancela la notificación", () => {
    escalator.watch(pending);
    vi.advanceTimersByTime(30_000);
    escalator.resolve(pending.id);
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
  });

  it("vigilar dos veces el mismo id produce una sola notificación y no reinicia el plazo", () => {
    escalator.watch(pending);
    vi.advanceTimersByTime(40_000);
    escalator.watch(pending);
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(1);
  });

  it("con since cuenta el minuto desde ese instante (re-armado tras reinicio)", () => {
    escalator.watch(pending, { since: new Date("2026-10-29T11:59:30.000Z") });
    vi.advanceTimersByTime(29_999);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
  });

  it("con since ya vencido notifica de inmediato en el siguiente tick", () => {
    escalator.watch(pending, { since: new Date("2026-10-29T11:00:00.000Z") });
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(1);
  });

  it("vigila ids distintos de forma independiente", () => {
    escalator.watch(pending);
    escalator.watch({ ...pending, id: "blocked:r-1:1", kind: "agent_blocked" });
    escalator.resolve(pending.id);
    vi.advanceTimersByTime(60_000);
    expect(sent.map((n) => n.id)).toEqual(["blocked:r-1:1"]);
  });

  it("stop cancela todo lo pendiente", () => {
    escalator.watch(pending);
    escalator.stop();
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
    expect(escalator.pending()).toEqual([]);
  });

  it("un fallo al notificar se reporta y no rompe el escalador", async () => {
    const onError = vi.fn();
    const failing = new Escalator({ notify: () => Promise.reject(new Error("x")), onError });
    failing.watch(pending);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ id: pending.id }),
    );
  });
});
