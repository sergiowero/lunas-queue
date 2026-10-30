// Timeout de fase con pausa (docs/design.md §Timeout de fase): corre mientras el Run está en
// running y se pausa en `blocked` o `waiting_human`, porque ese tiempo depende del humano. En
// memoria: tras un reinicio se arma de nuevo con el presupuesto completo (ADR
// uw-17-reconciliacion).

export type PauseReason = "blocked" | "waiting_human";

export class PhaseClock {
  private remaining: number;
  private readonly onExpire: () => void;
  private readonly paused = new Set<PauseReason>();
  private started = false;
  private stopped = false;
  /** Desde cuándo corre el tramo actual; null en pausa o sin arrancar. */
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

  /** Arranca el tramo si nada lo impide. */
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

  /** Cierra el tramo en curso y descuenta lo corrido. */
  private halt(): void {
    if (this.since === null) return;
    this.remaining -= Date.now() - this.since;
    this.since = null;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
