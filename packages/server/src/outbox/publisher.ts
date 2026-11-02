// In-process outbox publisher (docs/design.md §Components, ADR 0011). It reads the pending ones
// in write order, delivers them to the subscribers (scheduler, dispatcher) and marks them.
// At-least-once delivery: if the process crashes between delivering and marking, the message repeats on
// start, so subscribers must be idempotent.
import {
  type LunasqDatabase,
  listPendingOutbox,
  markOutboxPublished,
  type PendingOutboxEntry,
  recordOutboxFailure,
} from "@lunasq/db";
import type { OutboxMessage } from "@lunasq/schemas";

export const DEFAULT_POLL_INTERVAL_MS = 1000;

export type OutboxHandler = (message: OutboxMessage) => void | Promise<void>;

/** `failed` is the message whose delivery failed, or null if reading the queue failed. */
export type OutboxErrorHandler = (error: Error, failed: PendingOutboxEntry | null) => void;

export interface OutboxPublisherOptions {
  db: LunasqDatabase;
  onError?: OutboxErrorHandler;
  pollIntervalMs?: number;
  batchSize?: number;
}

export class OutboxPublisher {
  private readonly db: LunasqDatabase;
  private readonly onError: OutboxErrorHandler;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly handlers = new Map<string, Set<OutboxHandler>>();
  private running: Promise<number> | undefined;
  // Request for another pass while a drain runs: what was confirmed after its read.
  private rerun = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: OutboxPublisherOptions) {
    this.db = opts.db;
    this.onError = opts.onError ?? defaultError;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = opts.batchSize ?? 100;
  }

  /**
   * `topic` is the event type or `*` for all. With at least one registered subscriber, a
   * message whose topic has no recipients is marked published; with none, nothing is published.
   */
  subscribe(topic: string, handler: OutboxHandler): () => void {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler);
    this.handlers.set(topic, set);
    return () => {
      set.delete(handler);
    };
  }

  /** Delivers what is pending and returns how many messages it published. One pass at a time. */
  drain(): Promise<number> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    // Starts in a microtask: a handler that calls wake already sees `running` assigned.
    this.running = Promise.resolve()
      .then(() => this.loop())
      .finally(() => {
        this.running = undefined;
        // A wake that arrived after the queue's last read (or a start after stop).
        if (this.rerun && !this.stopped) this.wake();
      });
    return this.running;
  }

  /** Requests a drain without waiting for it; to call after confirming a transition. */
  wake(): void {
    this.drain().catch((error: unknown) => this.report(toError(error), null));
  }

  /** Delivers what was left pending (e.g. from a crash) and starts the periodic poll. */
  async start(): Promise<void> {
    this.stopped = false;
    if (!this.timer) this.timer = setInterval(() => this.wake(), this.pollIntervalMs);
    await this.drain().catch((error: unknown) => this.report(toError(error), null));
  }

  /** Stops the poll and waits for the drain in progress, which ends after the current message. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }

  private async loop(): Promise<number> {
    let published = 0;
    // Without any subscriber nothing is marked: what is pending waits for someone to subscribe.
    if ([...this.handlers.values()].every((set) => set.size === 0)) {
      this.rerun = false;
      return published;
    }
    do {
      this.rerun = false;
      for (;;) {
        if (this.stopped) return published;
        const batch = listPendingOutbox(this.db, { limit: this.batchSize });
        for (const entry of batch) {
          // On a failure it stops so as not to deliver out of order; the next drain retries.
          if (!(await this.deliver(entry))) {
            // No extra pass: the retry waits for the next wake or poll, it does not loop.
            this.rerun = false;
            return published;
          }
          markOutboxPublished(this.db, entry.message.id);
          published += 1;
          if (this.stopped) return published;
        }
        if (batch.length < this.batchSize) break;
      }
    } while (this.rerun);
    return published;
  }

  private async deliver(entry: PendingOutboxEntry): Promise<boolean> {
    const { message } = entry;
    const targets = [
      ...(this.handlers.get(message.topic) ?? []),
      ...(this.handlers.get("*") ?? []),
    ];
    try {
      for (const handler of targets) await handler(message);
      return true;
    } catch (error) {
      const attempts = recordOutboxFailure(this.db, message.id);
      this.report(toError(error), { message, attempts });
      return false;
    }
  }

  private report(error: Error, failed: PendingOutboxEntry | null): void {
    try {
      this.onError(error, failed);
    } catch {
      // A broken onError does not stop the publisher.
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultError(error: Error, failed: PendingOutboxEntry | null): void {
  const where = failed ? `message ${failed.message.id} (attempt ${failed.attempts})` : "read";
  console.error(`[outbox] failure in ${where}: ${error.message}`);
}
