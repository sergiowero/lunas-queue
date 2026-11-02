// Phase timeout with pause (docs/design.md §Phase timeout): it runs while the Run is in
// running and pauses in `blocked` or `waiting_human`, because that time depends on the human. In
// memory: after a restart it is set up again with the full budget (ADR
// uw-17-reconciliacion).

export type PauseReason = "blocked" | "waiting_human";

export class PhaseClock {
  private remaining: number;
  private readonly onExpire: () => void;
  private readonly paused = new Set<PauseReason>();
  private started = false;
  private stopped = false;
  /** Since when the current stretch runs; null when paused or not started. */
  private since: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(budgetMs: number, onExpire: () => void) {
    this.remaining = budgetMs;
    this.onExpire = onExpire;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule();
  }

  pause(reason: PauseReason): void {
    if (this.paused.has(reason)) return;
    this.paused.add(reason);
    this.halt();
  }

  resume(reason: PauseReason): void {
    if (!this.paused.delete(reason)) return;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.halt();
  }

  remainingMs(): number {
    return this.since === null ? this.remaining : this.remaining - (Date.now() - this.since);
  }

  /** Starts the stretch if nothing prevents it. */
  private schedule(): void {
    if (!this.started || this.stopped || this.paused.size > 0 || this.since !== null) return;
    this.since = Date.now();
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.since = null;
        this.remaining = 0;
        this.stopped = true;
        this.onExpire();
      },
      Math.max(0, this.remaining),
    );
  }

  /** Closes the current stretch and deducts what ran. */
  private halt(): void {
    if (this.since === null) return;
    this.remaining -= Date.now() - this.since;
    this.since = null;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
