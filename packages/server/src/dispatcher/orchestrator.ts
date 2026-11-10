// Composition of scheduler, dispatcher, observation and reconciliation in the server process
// (ADR 0014, ADR uw-16-dispatcher, ADR uw-17-reconciliacion): the dispatcher implements the scheduler's
// port and both share limits; the watcher observes the launched Runs and the reconciler
// compares the database with herdr. The outbox publisher is started by whoever creates it; here only the
// consumers are subscribed to it.
import type { HerdrAdapter, ProcessRunner } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  ProjectRepository,
  ProjectWorkspaceRepository,
  RunRepository,
  TaskWorktreeRepository,
} from "@lunasq/db";
import {
  type Notification,
  type OutboxMessage,
  type SchedulerConfigInput,
  TASK_PR_STATE_CHANGED,
  TASK_TRANSITIONED,
  TaskTransitionedPayload,
} from "@lunasq/schemas";
import type { PhaseHooks } from "../mcp/ports.ts";
import type { Escalator } from "../notifications/escalator.ts";
import { createNotifications } from "../notifications/index.ts";
import type { OutboxPublisher } from "../outbox/publisher.ts";
import { QuestionEscalations } from "../questions/escalations.ts";
import { QuestionService } from "../questions/service.ts";
import { escalationNotification } from "../reconciler/escalations.ts";
import { type ReconcileErrorHandler, Reconciler } from "../reconciler/reconciler.ts";
import { RunWatcher } from "../reconciler/watcher.ts";
import { Scheduler, type SchedulerErrorHandler } from "../scheduler/scheduler.ts";
import { WorktreeService } from "../worktrees/service.ts";
import {
  type DispatchErrorHandler,
  PhaseDispatcher,
  type RunEvidenceSink,
  type RunObserver,
} from "./dispatcher.ts";
import { ensureHookSettings } from "./hook-settings.ts";
import { ensureMcpConfig } from "./mcp-config.ts";

export interface OrchestratorOptions {
  db: LunasqDatabase;
  herdr: HerdrAdapter;
  processes: ProcessRunner;
  /** Stable MCP file and LunasQ MCP URL it writes on start (ADR 0002). */
  mcp: { configPath: string; url: string };
  /** Stable settings and URL of the subagent hooks endpoint (ADR uw-19-revisores). */
  hooks: { settingsPath: string; url: string };
  config?: SchedulerConfigInput;
  publisher?: OutboxPublisher;
  paneEnv?: Record<string, string>;
  /** Replaces the `RunWatcher` (tests). */
  observer?: RunObserver;
  /** Evidence file: updated when each Run closes, also those the MCP closes. */
  evidence?: RunEvidenceSink;
  /**
   * Hooks the dispatcher runs before starting the agent of a refine or implement Run
   * (`before_refinement`, `before_implementation`). HookService needs `orchestrator.worktrees`, so
   * whoever composes it passes a port that delegates to it once it exists.
   */
  phaseHooks?: PhaseHooks;
  /**
   * Notices to the human: blocked, timeout, exhausted retries and loops. Without this, the notifications
   * module is built with herdr as the channel (`notifications` exposes it to mount the SSE).
   */
  notifications?: { notify(n: Notification): unknown; escalator: Escalator };
  reconcile?: {
    intervalMs?: number;
    orphanWorktreesEvery?: number;
    maxNudges?: number;
    nudgeGraceMs?: number;
  };
  onDispatchError?: DispatchErrorHandler;
  onSchedulerError?: SchedulerErrorHandler;
  onReconcileError?: ReconcileErrorHandler;
}

export class Orchestrator {
  readonly worktrees: WorktreeService;
  readonly dispatcher: PhaseDispatcher;
  readonly scheduler: Scheduler;
  readonly watcher: RunWatcher;
  readonly reconciler: Reconciler;
  /** Answers the Questions (ADR uw-22-preguntas): passed to `createApp({ questions })`. */
  readonly questions: QuestionService;
  /** The notifications module built by default, if one was not passed. */
  readonly notifications: ReturnType<typeof createNotifications> | undefined;
  private readonly notify: (n: Notification) => unknown;
  private readonly mcp: { configPath: string; url: string };
  private readonly hooks: { settingsPath: string; url: string };
  private readonly publisher: OutboxPublisher | undefined;
  private readonly questionEscalations: QuestionEscalations;
  private readonly runs: RunRepository;
  private readonly tasks: TaskWorktreeRepository;
  private unsubscribes: (() => void)[] = [];

  constructor(opts: OrchestratorOptions) {
    const projects = new ProjectRepository(opts.db);
    this.mcp = opts.mcp;
    this.hooks = opts.hooks;
    this.publisher = opts.publisher;
    this.runs = new RunRepository(opts.db);
    this.tasks = new TaskWorktreeRepository(opts.db);
    this.worktrees = new WorktreeService({
      herdr: opts.herdr,
      processes: opts.processes,
      projects,
      tasks: new TaskWorktreeRepository(opts.db),
      workspaces: new ProjectWorkspaceRepository(opts.db),
    });
    let notifications = opts.notifications;
    if (!notifications) {
      const created = createNotifications({ herdr: opts.herdr });
      this.notifications = created;
      notifications = { notify: (n) => created.service.notify(n), escalator: created.escalator };
    }
    this.notify = (n) => notifications.notify(n);
    const reconcile = opts.reconcile ?? {};
    this.watcher = new RunWatcher({
      db: opts.db,
      herdr: opts.herdr,
      projects,
      escalator: notifications.escalator,
      notify: this.notify,
      failRun: (runId, reason) => this.dispatcher.failRun(runId, reason),
      onLost: () => this.reconciler.wake(),
      ...(reconcile.maxNudges !== undefined && { maxNudges: reconcile.maxNudges }),
      ...(reconcile.nudgeGraceMs !== undefined && { nudgeGraceMs: reconcile.nudgeGraceMs }),
      ...(opts.onReconcileError && { onError: opts.onReconcileError }),
    });
    this.dispatcher = new PhaseDispatcher({
      db: opts.db,
      herdr: opts.herdr,
      worktrees: this.worktrees,
      projects,
      mcpConfigPath: opts.mcp.configPath,
      mcpUrl: opts.mcp.url,
      hookSettingsPath: opts.hooks.settingsPath,
      observer: opts.observer ?? this.watcher,
      ...(opts.evidence && { evidence: opts.evidence }),
      ...(opts.phaseHooks && { hooks: opts.phaseHooks }),
      ...(opts.config && { config: opts.config }),
      ...(opts.paneEnv && { paneEnv: opts.paneEnv }),
      ...(opts.onDispatchError && { onError: opts.onDispatchError }),
    });
    this.reconciler = new Reconciler({
      db: opts.db,
      herdr: opts.herdr,
      dispatcher: this.dispatcher,
      watcher: this.watcher,
      worktrees: this.worktrees,
      projects,
      onRunsClosed: () => this.scheduler.wake(),
      ...(reconcile.intervalMs !== undefined && { intervalMs: reconcile.intervalMs }),
      ...(reconcile.orphanWorktreesEvery !== undefined && {
        orphanWorktreesEvery: reconcile.orphanWorktreesEvery,
      }),
      ...(opts.onReconcileError && { onError: opts.onReconcileError }),
    });
    this.questionEscalations = new QuestionEscalations({
      db: opts.db,
      escalator: notifications.escalator,
    });
    this.questions = new QuestionService({
      db: opts.db,
      herdr: opts.herdr,
      dispatcher: this.dispatcher,
      escalator: notifications.escalator,
      // The old Run is already closed: the scheduler can dispatch the new one without waiting for the tick.
      onAnswered: () => this.scheduler.wake(),
      ...(opts.onReconcileError && { onError: (error) => opts.onReconcileError?.(error, null) }),
    });
    this.scheduler = new Scheduler({
      db: opts.db,
      dispatcher: this.dispatcher,
      projects,
      ...(opts.config && { config: opts.config }),
      ...(opts.publisher && { publisher: opts.publisher }),
      ...(opts.onSchedulerError && { onError: opts.onSchedulerError }),
    });
  }

  /**
   * Writes the MCP and hooks files, resumes half-done dispatches, reconciles with herdr
   * (observes the live Runs again) and starts the scheduler.
   */
  async start(): Promise<void> {
    await ensureMcpConfig(this.mcp.configPath, this.mcp.url);
    await ensureHookSettings(this.hooks.settingsPath, this.hooks.url);
    await this.dispatcher.recover();
    if (this.unsubscribes.length === 0 && this.publisher) {
      this.unsubscribes = [
        this.publisher.subscribe(TASK_TRANSITIONED, async (m) => {
          if (m.taskId === null) return;
          this.watcher.onTransition(m);
          this.reconciler.onMessage(m);
          this.questionEscalations.onTransition(m);
          const task = this.tasks.get(m.taskId);
          const notification = task && escalationNotification(task.number, m);
          if (notification) await this.notify(notification);
          await this.onTransition(m);
        }),
        this.publisher.subscribe(TASK_PR_STATE_CHANGED, (m) => this.reconciler.onMessage(m)),
      ];
    }
    await this.reconciler.start();
    this.questionEscalations.rearm();
    await this.scheduler.start();
  }

  /**
   * The task left running: if its last Run is already closed (an MCP tool closed it), its
   * pane is cleaned. Idempotent, as the outbox requires (at-least-once delivery).
   */
  async onTransition(message: OutboxMessage): Promise<void> {
    const payload = TaskTransitionedPayload.safeParse(message.payload);
    if (!payload.success) return;
    const { from, to } = payload.data;
    if (message.taskId === null || from.subState !== "running" || to.subState === "running") return;
    const run = this.runs.latestForTask(message.taskId);
    if (run?.endedAt) await this.dispatcher.releaseRun(run.id);
  }

  /** Stops scheduler and reconciliation, waits for launches in progress and stops observing. */
  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    await this.reconciler.stop();
    await this.scheduler.stop();
    await this.dispatcher.idle();
    await this.watcher.stop();
    this.notifications?.escalator.stop();
  }
}
