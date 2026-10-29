// Escalamiento a 1 minuto (docs/design.md §Señales): un agente `blocked` o una Question
// abierta se notifica si sigue así pasado el plazo. Quien detecta la situación llama
// `watch`; quien la ve resuelta llama `resolve`.
import type { Notification } from "@lunasq/schemas";

export const ESCALATION_DELAY_MS = 60_000;

export type PendingNotification = Omit<Notification, "createdAt">;

export class Escalator {
  private readonly notify: (notification: Notification) => unknown;
  private readonly onError: (error: Error, notification: Notification) => void;
  private readonly delayMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Ya escalados y sin resolver: un `watch` repetido (p. ej. al reconciliar) no hace nada.
  private readonly fired = new Set<string>();

  constructor(opts: {
    notify: (notification: Notification) => unknown;
    onError?: (error: Error, notification: Notification) => void;
    delayMs?: number;
  }) {
    this.notify = opts.notify;
    this.onError = opts.onError ?? defaultError;
    this.delayMs = opts.delayMs ?? ESCALATION_DELAY_MS;
  }

  /**
   * Programa la notificación a `delayMs` desde `since` (por defecto, ahora). `since` permite
   * re-armar el plazo tras un reinicio desde la BD. Repetir con un id vigilado o ya escalado
   * (y sin resolver) no hace nada.
   */
  watch(pending: PendingNotification, opts: { since?: Date } = {}): void {
    if (this.timers.has(pending.id) || this.fired.has(pending.id)) return;
    const since = opts.since?.getTime() ?? Date.now();
    if (Number.isNaN(since)) throw new Error(`since inválido para ${pending.id}`);
    const wait = Math.max(0, since + this.delayMs - Date.now());
    const timer = setTimeout(() => this.fire(pending), wait);
    this.timers.set(pending.id, timer);
  }

  resolve(id: string): void {
    this.fired.delete(id);
    const timer = this.timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(id);
  }

  /** Ids con el plazo corriendo. */
  pending(): string[] {
    return [...this.timers.keys()];
  }

  /** Ids ya escalados que siguen sin resolverse. */
  escalated(): string[] {
    return [...this.fired];
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.fired.clear();
  }

  private fire(pending: PendingNotification): void {
    this.timers.delete(pending.id);
    this.fired.add(pending.id);
    const notification: Notification = { ...pending, createdAt: new Date().toISOString() };
    const report = (error: unknown) =>
      this.onError(error instanceof Error ? error : new Error(String(error)), notification);
    try {
      Promise.resolve(this.notify(notification)).catch(report);
    } catch (error) {
      report(error);
    }
  }
}

function defaultError(error: Error, notification: Notification): void {
  console.warn(`[notificaciones] no se pudo escalar ${notification.id}: ${error.message}`);
}
