import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhaseClock } from "./phase-clock.ts";

const MIN = 60_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PhaseClock", () => {
  it("vence al agotar el presupuesto corriendo", () => {
    const expired = vi.fn();
    new PhaseClock(30 * MIN, expired).start();
    vi.advanceTimersByTime(30 * MIN - 1);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("no corre en pausa y retoma con lo que quedaba", () => {
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

  it("solo corre cuando no queda ninguna razón de pausa", () => {
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

  it("pausar o reanudar dos veces no cambia nada", () => {
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

  it("detenido no vence", () => {
    const expired = vi.fn();
    const clock = new PhaseClock(MIN, expired);
    clock.start();
    clock.stop();
    clock.resume("blocked");
    vi.advanceTimersByTime(10 * MIN);
    expect(expired).not.toHaveBeenCalled();
  });

  it("una pausa antes de arrancar se respeta al arrancar", () => {
    const expired = vi.fn();
    const clock = new PhaseClock(MIN, expired);
    clock.pause("blocked");
    clock.start();
    vi.advanceTimersByTime(10 * MIN);
    expect(expired).not.toHaveBeenCalled();
  });
});
