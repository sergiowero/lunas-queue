// Merge detection by polling (docs/design.md §Decisions: polling with `gh` in v1;
// ADR uw-14-adapter-github).
// Each pass queries GitHub for the open PRs the database knows and records those that were
// merged or closed. The record leaves its event in the outbox; the scheduler receives it and releases
// the dependents or escalates them (ADR 0014). An open PR that GitHub marks as in conflict with the
// base (another PR was merged first) sends its task back to in_progress so the implementer integrates
// the base (ADR pr-en-conflicto). Repeating a pass does not duplicate effects.
import type { GitHubAdapter } from "@lunasq/adapters";
import { type LunasqDatabase, TaskPrRepository } from "@lunasq/db";
import type { PrTrackingStore, TrackedPr } from "@lunasq/domain";
import { DELIVERY_OUTPUT_LIMIT } from "@lunasq/schemas";
import type { OutboxPublisher } from "../outbox/publisher.ts";

export const DEFAULT_PR_POLL_INTERVAL_MS = 60_000;
export const MIN_PR_POLL_INTERVAL_MS = 1_000;

export interface PrPollerOptions {
  github: GitHubAdapter;
  db?: LunasqDatabase;
  /** By default, TaskPrRepository over `db`. */
  store?: PrTrackingStore;
  /** Woken after recording changes, so the scheduler sees them without waiting. */
  publisher?: OutboxPublisher;
  intervalMs?: number;
  /** `pr` is the PR that failed, or null if reading the database failed. */
  onError?: (error: Error, pr: TrackedPr | null) => void;
}

export type PrPollResult = {
  merged: string[];
  closed: string[];
  conflicted: string[];
  ciFailed: string[];
};

export class PrPoller {
  private readonly github: GitHubAdapter;
  private readonly store: PrTrackingStore;
  private readonly publisher: OutboxPublisher | undefined;
  private readonly intervalMs: number;
  private readonly onError: (error: Error, pr: TrackedPr | null) => void;
  private running: Promise<PrPollResult> | undefined;
  private rerun = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: PrPollerOptions) {
    const store = opts.store ?? (opts.db ? new TaskPrRepository(opts.db) : undefined);
    if (!store) throw new Error("PrPoller necesita store o db");
    const intervalMs = opts.intervalMs ?? DEFAULT_PR_POLL_INTERVAL_MS;
    if (!Number.isInteger(intervalMs) || intervalMs < MIN_PR_POLL_INTERVAL_MS) {
      throw new Error(`intervalMs must be an integer >= ${MIN_PR_POLL_INTERVAL_MS}`);
    }
    this.github = opts.github;
    this.store = store;
    this.publisher = opts.publisher;
    this.intervalMs = intervalMs;
    this.onError = opts.onError ?? defaultError;
  }

  /** One pass (or joins the one running and asks for another). Returns what the last one did. */
  poll(): Promise<PrPollResult> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = Promise.resolve()
      .then(() => this.loop())
      .finally(() => {
        this.running = undefined;
        if (this.rerun && !this.stopped) this.wake();
      });
    return this.running;
  }

  /** Asks for a pass without waiting for it. */
  wake(): void {
    this.poll().catch((error: unknown) => this.report(toError(error), null));
  }

  /** Starts periodic polling with a first pass. */
  async start(): Promise<void> {
    this.stopped = false;
    this.timer ??= setInterval(() => this.wake(), this.intervalMs);
    await this.poll().catch((error: unknown) => this.report(toError(error), null));
  }

  /** Stops polling and waits for the pass in progress, which queries no more PRs. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }

  private async loop(): Promise<PrPollResult> {
    let result: PrPollResult = { merged: [], closed: [], conflicted: [], ciFailed: [] };
    do {
      this.rerun = false;
      if (this.stopped) break;
      result = await this.pass();
    } while (this.rerun);
    return result;
  }

  private async pass(): Promise<PrPollResult> {
    const result: PrPollResult = { merged: [], closed: [], conflicted: [], ciFailed: [] };
    for (const tracked of this.store.listOpen()) {
      if (this.stopped) break;
      try {
        // A PR that fails (network, rate limit, deleted PR) does not stop the pass.
        const pr = await this.github.getPr(tracked.url);
        const at = pr.state === "merged" ? pr.mergedAt : pr.closedAt;
        const changed = this.store.recordPrState(tracked.taskId, {
          url: tracked.url,
          state: pr.state,
          at,
        });
        if (changed && pr.state === "merged") result.merged.push(tracked.taskId);
        if (changed && pr.state === "closed") result.closed.push(tracked.taskId);
        if (
          pr.state === "open" &&
          pr.mergeable === "conflicting" &&
          this.store.recordPrConflict(tracked.taskId, tracked.url)
        ) {
          result.conflicted.push(tracked.taskId);
        } else if (pr.state === "open" && pr.checks.status === "failure") {
          const output =
            pr.checks.items
              .filter((check) => check.status === "failure")
              .map((check) => (check.url ? `${check.name}: ${check.url}` : check.name))
              .join("\n")
              .slice(0, DELIVERY_OUTPUT_LIMIT) || "GitHub reported failed checks without details";
          if (this.store.recordPrCiFailure(tracked.taskId, tracked.url, output)) {
            result.ciFailed.push(tracked.taskId);
          }
        }
      } catch (error) {
        this.report(toError(error), tracked);
      }
    }
    if (
      result.merged.length +
        result.closed.length +
        result.conflicted.length +
        result.ciFailed.length >
      0
    ) {
      this.publisher?.wake();
    }
    return result;
  }

  private report(error: Error, pr: TrackedPr | null): void {
    try {
      this.onError(error, pr);
    } catch {
      // A broken onError does not stop the poller.
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultError(error: Error, pr: TrackedPr | null): void {
  const where = pr ? `task ${pr.taskId} (${pr.url})` : "read";
  console.error(`[pr-poller] fallo en ${where}: ${error.message}`);
}
