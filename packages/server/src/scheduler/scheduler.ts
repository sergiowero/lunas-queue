// In-process scheduler (docs/design.md §Scheduler, ADR 0014). Each pass reads a snapshot of the
// database, computes the plan with @lunasq/domain, escalates the dependents of dependencies that will no
// longer be delivered and hands the decisions to the dispatcher one by one. It runs on each outbox
// message and on a periodic tick; since it recomputes everything from the database, repeating a pass does not
// duplicate effects.
import {
  type ConcurrencySettingsReader,
  type LunasqDatabase,
  ProjectRepository,
  type ProviderSettingsReader,
  SchedulerStateRepository,
  SettingsRepository,
  transitionTask,
} from "@lunasq/db";
import {
  type DependencyEscalation,
  type DispatchDecision,
  type ProjectConfigReader,
  type SchedulerStateReader,
  schedule,
} from "@lunasq/domain";
import { SchedulerConfig, type SchedulerConfigInput } from "@lunasq/schemas";
import type { OutboxPublisher } from "../outbox/publisher.ts";

/**
 * Port toward the dispatcher (UW-16). `dispatch` resolves when the claim was confirmed (the
 * task is already in running) or rejects if it could not be; this way the next pass sees the slot taken.
 * The claim must validate the limits again: the plan was computed earlier.
 */
export interface Dispatcher {
  dispatch(decision: DispatchDecision): Promise<void>;
}

/** `failed` is the decision or escalation that failed, or null if the read failed. */
export type SchedulerErrorHandler = (
  error: Error,
  failed: DispatchDecision | DependencyEscalation | null,
) => void;

export interface SchedulerOptions {
  db: LunasqDatabase;
  dispatcher: Dispatcher;
  config?: SchedulerConfigInput;
  /** Subscribes to all its topics and is woken after escalating. */
  publisher?: OutboxPublisher;
  state?: SchedulerStateReader;
  projects?: ProjectConfigReader;
  /**
   * Enabled providers and global concurrency limit; read on each pass. By default,
   * those of the database.
   */
  settings?: ProviderSettingsReader & ConcurrencySettingsReader;
  now?: () => Date;
  onError?: SchedulerErrorHandler;
}

export type SchedulerPassResult = { dispatched: string[]; escalated: string[] };

export class Scheduler {
  private readonly db: LunasqDatabase;
  private readonly dispatcher: Dispatcher;
  private readonly config: SchedulerConfig;
  private readonly publisher: OutboxPublisher | undefined;
  private readonly state: SchedulerStateReader;
  private readonly projects: ProjectConfigReader;
  private readonly settings: ProviderSettingsReader & ConcurrencySettingsReader;
  private readonly now: () => Date;
  private readonly onError: SchedulerErrorHandler;
  private running: Promise<SchedulerPassResult> | undefined;
  // Request for another pass while one runs: what changed after its read.
  private rerun = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(opts: SchedulerOptions) {
    this.db = opts.db;
    this.dispatcher = opts.dispatcher;
    this.config = SchedulerConfig.parse(opts.config ?? {});
    this.publisher = opts.publisher;
    this.state = opts.state ?? new SchedulerStateRepository(opts.db);
    this.projects = opts.projects ?? new ProjectRepository(opts.db);
    this.settings = opts.settings ?? new SettingsRepository(opts.db);
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError ?? defaultError;
  }

  /** One pass (or joins the one running and asks for another). Returns what the last one did. */
  run(): Promise<SchedulerPassResult> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = Promise.resolve()
      .then(() => this.loop())
      .finally(() => {
        this.running = undefined;
        // A request that arrived after the last rerun check (or a start after stop).
        if (this.rerun && !this.stopped) this.wake();
      });
    return this.running;
  }

  /** Requests a pass without waiting for it. */
  wake(): void {
    this.run().catch((error: unknown) => this.report(toError(error), null));
  }

  /** Subscribes to the outbox, starts the tick and does a first pass. */
  async start(): Promise<void> {
    this.stopped = false;
    // The handler does not wait for the pass: it does not hold back the publisher and the pass reads the database anyway.
    this.unsubscribe ??= this.publisher?.subscribe("*", () => this.wake());
    this.timer ??= setInterval(() => this.wake(), this.config.tickIntervalMs);
    await this.run().catch((error: unknown) => this.report(toError(error), null));
  }

  /** Stops the tick and the subscription and waits for the pass in progress, which dispatches no more. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.running?.catch(() => {});
  }

  private async loop(): Promise<SchedulerPassResult> {
    let result: SchedulerPassResult = { dispatched: [], escalated: [] };
    do {
      this.rerun = false;
      if (this.stopped) break;
      result = await this.pass();
    } while (this.rerun);
    return result;
  }

  private async pass(): Promise<SchedulerPassResult> {
    // The configuration is read on each pass: a change in Settings applies to the next pass.
    const plan = schedule(
      this.state.snapshot(),
      this.projects,
      {
        ...this.config,
        globalConcurrency: this.settings.concurrency(this.config.globalConcurrency)
          .globalConcurrency,
      },
      this.now(),
      this.settings.providers(),
    );
    const escalated = plan.escalate.filter((e) => this.escalate(e));
    if (escalated.length > 0) this.publisher?.wake();

    const dispatched: string[] = [];
    for (const decision of plan.dispatch) {
      if (this.stopped) break;
      try {
        await this.dispatcher.dispatch(decision);
        dispatched.push(decision.taskId);
      } catch (error) {
        // A lost claim does not stop the pass: the other decisions are still valid.
        this.report(toError(error), decision);
      }
    }
    return { dispatched, escalated: escalated.map((e) => e.taskId) };
  }

  private escalate(escalation: DependencyEscalation): boolean {
    // A failure (e.g. of the database) is reported with its escalation and does not skip the dispatches.
    let result: ReturnType<typeof transitionTask>;
    try {
      result = transitionTask(this.db, {
        taskId: escalation.taskId,
        actor: "system",
        command: {
          type: "escalate",
          reason: "dependency_pr_closed",
          note: `dependency ${escalation.dependsOnId} will no longer be delivered`,
        },
        expected: escalation.expected,
      });
    } catch (error) {
      this.report(toError(error), escalation);
      return false;
    }
    if (result.ok) return true;
    // stale_state: the task moved after the read; the next pass re-evaluates it.
    if (result.error.code !== "stale_state") {
      this.report(new Error(`${result.error.code}: ${result.error.message}`), escalation);
    }
    return false;
  }

  private report(error: Error, failed: DispatchDecision | DependencyEscalation | null): void {
    try {
      this.onError(error, failed);
    } catch {
      // A broken onError does not stop the scheduler.
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultError(error: Error, failed: DispatchDecision | DependencyEscalation | null): void {
  const where = failed ? `task ${failed.taskId}` : "read";
  console.error(`[scheduler] fallo en ${where}: ${error.message}`);
}
