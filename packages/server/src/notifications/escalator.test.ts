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

  it("escalates at 1 minute by default", () => {
    expect(ESCALATION_DELAY_MS).toBe(60_000);
  });

  it("does not notify before the minute and does so when it is up", () => {
    escalator.watch(pending);
    vi.advanceTimersByTime(59_999);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ ...pending, createdAt: "2026-10-29T12:01:00.000Z" }]);
    expect(escalator.pending()).toEqual([]);
  });

  it("resolving before the minute cancels the notification", () => {
    escalator.watch(pending);
    vi.advanceTimersByTime(30_000);
    escalator.resolve(pending.id);
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
  });

  it("watching the same id twice produces a single notification and does not reset the deadline", () => {
    escalator.watch(pending);
    vi.advanceTimersByTime(40_000);
    escalator.watch(pending);
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(1);
  });

  it("with since it counts the minute from that instant (re-armed after a restart)", () => {
    escalator.watch(pending, { since: new Date("2026-10-29T11:59:30.000Z") });
    vi.advanceTimersByTime(29_999);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
  });

  it("with since already expired it notifies immediately on the next tick", () => {
    escalator.watch(pending, { since: new Date("2026-10-29T11:00:00.000Z") });
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(1);
  });

  it("rejects an invalid since", () => {
    expect(() => escalator.watch(pending, { since: new Date("no es fecha") })).toThrow(/since/);
    expect(escalator.pending()).toEqual([]);
  });

  it("after escalating, watching the same id does not arm another timer until it is resolved", () => {
    escalator.watch(pending);
    vi.advanceTimersByTime(60_000);
    escalator.watch(pending);
    expect(escalator.pending()).toEqual([]);
    expect(escalator.escalated()).toEqual([pending.id]);
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(1);
    escalator.resolve(pending.id);
    expect(escalator.escalated()).toEqual([]);
    escalator.watch(pending);
    expect(escalator.pending()).toEqual([pending.id]);
  });

  it("watches different ids independently", () => {
    escalator.watch(pending);
    escalator.watch({ ...pending, id: "blocked:r-1:1", kind: "agent_blocked" });
    escalator.resolve(pending.id);
    vi.advanceTimersByTime(60_000);
    expect(sent.map((n) => n.id)).toEqual(["blocked:r-1:1"]);
  });

  it("stop cancels everything pending", () => {
    escalator.watch(pending);
    escalator.stop();
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
    expect(escalator.pending()).toEqual([]);
  });

  it("a failure notifying is reported and does not break the escalator", async () => {
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
