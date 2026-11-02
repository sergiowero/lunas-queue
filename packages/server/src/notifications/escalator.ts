// Escalation at 1 minute (docs/design.md §Signals): a `blocked` agent or an open
// Question is notified if it stays that way past the deadline. Whoever detects the situation calls
// `watch`; whoever sees it resolved calls `resolve`.
import type { Notification } from "@lunasq/schemas";

export const ESCALATION_DELAY_MS = 60_000;

export type PendingNotification = Omit<Notification, "createdAt">;

export class Escalator {
  private readonly notify: (notification: Notification) => unknown;
  private readonly onError: (error: Error, notification: Notification) => void;
  private readonly delayMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Already escalated and unresolved: a repeated `watch` (e.g. when reconciling) does nothing.
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
   * Schedules the notification at `delayMs` from `since` (by default, now). `since` allows
   * re-arming the deadline after a restart from the DB. Repeating with a watched or already escalated id
   * (and unresolved) does nothing.
   */
  watch(pending: PendingNotification, opts: { since?: Date } = {}): void {
    if (this.timers.has(pending.id) || this.fired.has(pending.id)) return;
    const since = opts.since?.getTime() ?? Date.now();
    if (Number.isNaN(since)) throw new Error(`invalid since for ${pending.id}`);
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

  /** Ids with the deadline running. */
  pending(): string[] {
    return [...this.timers.keys()];
  }

  /** Ids already escalated that are still unresolved. */
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
  console.warn(`[notifications] could not escalate ${notification.id}: ${error.message}`);
}
