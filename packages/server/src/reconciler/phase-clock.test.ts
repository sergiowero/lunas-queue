import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhaseClock } from "./phase-clock.ts";

const MIN = 60_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PhaseClock", () => {
  it("expires when the budget runs out while running", () => {
    const expired = vi.fn();
    new PhaseClock(30 * MIN, expired).start();
    vi.advanceTimersByTime(30 * MIN - 1);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("does not run while paused and resumes with what was left", () => {
    const expired = vi.fn();
    const clock = new PhaseClock(30 * MIN, expired);
    clock.start();
    vi.advanceTimersByTime(10 * MIN);
    clock.pause("blocked");
    vi.advanceTimersByTime(5 * 60 * MIN);
    expect(expired).not.toHaveBeenCalled();
    expect(clock.remainingMs()).toBe(20 * MIN);
    clock.resume("blocked");
    vi.advanceTimersByTime(20 * MIN);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("only runs when no pause reason remains", () => {
    const expired = vi.fn();
    const clock = new PhaseClock(MIN, expired);
    clock.start();
    clock.pause("blocked");
    clock.pause("waiting_human");
    clock.resume("blocked");
    vi.advanceTimersByTime(10 * MIN);
    expect(expired).not.toHaveBeenCalled();
    clock.resume("waiting_human");
    vi.advanceTimersByTime(MIN);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("pausing or resuming twice changes nothing", () => {
    const expired = vi.fn();
    const clock = new PhaseClock(MIN, expired);
    clock.start();
    clock.pause("blocked");
    clock.pause("blocked");
    clock.resume("blocked");
    clock.resume("blocked");
    clock.resume("waiting_human");
    vi.advanceTimersByTime(MIN);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("a stopped one does not expire", () => {
    const expired = vi.fn();
    const clock = new PhaseClock(MIN, expired);
    clock.start();
    clock.stop();
    clock.resume("blocked");
    vi.advanceTimersByTime(10 * MIN);
    expect(expired).not.toHaveBeenCalled();
  });

  it("a pause before starting is respected on start", () => {
    const expired = vi.fn();
    const clock = new PhaseClock(MIN, expired);
    clock.pause("blocked");
    clock.start();
    vi.advanceTimersByTime(10 * MIN);
    expect(expired).not.toHaveBeenCalled();
  });
});
