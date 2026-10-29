// Detección de merges por polling (docs/design.md §Decisiones: polling con `gh` en v1; ADR 0015).
// Cada pasada consulta en GitHub los PR abiertos que la base conoce y registra los que se
// mergearon o cerraron. El registro deja su evento en el outbox; el scheduler lo recibe y libera
// a los dependientes o los escala (ADR 0014). Repetir una pasada no duplica efectos.
import type { GitHubAdapter } from "@lunasq/adapters";
import { type LunasqDatabase, TaskPrRepository } from "@lunasq/db";
import type { PrTrackingStore, TrackedPr } from "@lunasq/domain";
import type { OutboxPublisher } from "../outbox/publisher.ts";

export const DEFAULT_PR_POLL_INTERVAL_MS = 60_000;
export const MIN_PR_POLL_INTERVAL_MS = 1_000;

export interface PrPollerOptions {
  github: GitHubAdapter;
  db?: LunasqDatabase;
  /** Por defecto, TaskPrRepository sobre `db`. */
  store?: PrTrackingStore;
  /** Se despierta después de registrar cambios, para que el scheduler los vea sin esperar. */
  publisher?: OutboxPublisher;
  intervalMs?: number;
  /** `pr` es el PR que falló, o null si falló la lectura de la base. */
  onError?: (error: Error, pr: TrackedPr | null) => void;
}

export type PrPollResult = { merged: string[]; closed: string[] };

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
      throw new Error(`intervalMs debe ser un entero >= ${MIN_PR_POLL_INTERVAL_MS}`);
    }
    this.github = opts.github;
    this.store = store;
    this.publisher = opts.publisher;
    this.intervalMs = intervalMs;
    this.onError = opts.onError ?? defaultError;
  }

  /** Una pasada (o se une a la que corre y pide otra). Devuelve lo que hizo la última. */
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

  /** Pide una pasada sin esperarla. */
  wake(): void {
    this.poll().catch((error: unknown) => this.report(toError(error), null));
  }

  /** Arranca el polling periódico con una primera pasada. */
  async start(): Promise<void> {
    this.stopped = false;
    this.timer ??= setInterval(() => this.wake(), this.intervalMs);
    await this.poll().catch((error: unknown) => this.report(toError(error), null));
  }

  /** Detiene el polling y espera la pasada en curso, que no consulta más PRs. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }

  private async loop(): Promise<PrPollResult> {
    let result: PrPollResult = { merged: [], closed: [] };
    do {
      this.rerun = false;
      if (this.stopped) break;
      result = await this.pass();
    } while (this.rerun);
    return result;
  }

  private async pass(): Promise<PrPollResult> {
    const result: PrPollResult = { merged: [], closed: [] };
    for (const tracked of this.store.listOpen()) {
      if (this.stopped) break;
      try {
        // Un PR que falla (red, rate limit, PR borrado) no detiene la pasada.
        const pr = await this.github.getPr(tracked.url);
        const at = pr.state === "merged" ? pr.mergedAt : pr.closedAt;
        const changed = this.store.recordPrState(tracked.taskId, {
          url: tracked.url,
          state: pr.state,
          at,
        });
        if (changed && pr.state === "merged") result.merged.push(tracked.taskId);
        if (changed && pr.state === "closed") result.closed.push(tracked.taskId);
      } catch (error) {
        this.report(toError(error), tracked);
      }
    }
    if (result.merged.length + result.closed.length > 0) this.publisher?.wake();
    return result;
  }

  private report(error: Error, pr: TrackedPr | null): void {
    try {
      this.onError(error, pr);
    } catch {
      // Un onError roto no detiene al poller.
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultError(error: Error, pr: TrackedPr | null): void {
  const where = pr ? `tarea ${pr.taskId} (${pr.url})` : "lectura";
  console.error(`[pr-poller] fallo en ${where}: ${error.message}`);
}
