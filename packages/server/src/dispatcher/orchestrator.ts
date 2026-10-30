// Composición de scheduler, dispatcher, observación y reconciliación en el proceso del servidor
// (ADR 0014, ADR uw-16-dispatcher, ADR uw-17-reconciliacion): el dispatcher implementa el puerto
// del scheduler y ambos comparten límites; el watcher observa los Runs lanzados y el reconciliador
// compara la base con herdr. El publicador del outbox lo arranca quien lo crea; aquí solo se le
// suscriben los consumidores.
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
import type { Escalator } from "../notifications/escalator.ts";
import { createNotifications } from "../notifications/index.ts";
import type { OutboxPublisher } from "../outbox/publisher.ts";
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
  /** Archivo MCP estable y URL del LunasQ MCP que escribe al arrancar (ADR 0002). */
  mcp: { configPath: string; url: string };
  /** Settings estable y URL del endpoint de hooks de subagentes (ADR uw-19-revisores). */
  hooks: { settingsPath: string; url: string };
  config?: SchedulerConfigInput;
  publisher?: OutboxPublisher;
  paneEnv?: Record<string, string>;
  /** Reemplaza al `RunWatcher` (tests). */
  observer?: RunObserver;
  /** Archivo de evidencia (UW-24): se actualiza al cerrar cada Run, también los que cierra el MCP. */
  evidence?: RunEvidenceSink;
  /**
   * Avisos al humano: blocked, timeout, reintentos y loop agotados. Sin esto se arma el módulo de
   * notificaciones con herdr como canal (`notifications` lo expone para montar el SSE).
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
  /** El módulo de notificaciones que se armó por defecto, si no se pasó uno. */
  readonly notifications: ReturnType<typeof createNotifications> | undefined;
  private readonly notify: (n: Notification) => unknown;
  private readonly mcp: { configPath: string; url: string };
  private readonly hooks: { settingsPath: string; url: string };
  private readonly publisher: OutboxPublisher | undefined;
  private readonly runs: RunRepository;
  private unsubscribes: (() => void)[] = [];

  constructor(opts: OrchestratorOptions) {
    const projects = new ProjectRepository(opts.db);
    this.mcp = opts.mcp;
    this.hooks = opts.hooks;
    this.publisher = opts.publisher;
    this.runs = new RunRepository(opts.db);
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
      hookSettingsPath: opts.hooks.settingsPath,
      observer: opts.observer ?? this.watcher,
      ...(opts.evidence && { evidence: opts.evidence }),
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
   * Escribe los archivos MCP y de hooks, retoma los despachos a medias, reconcilia con herdr
   * (vuelve a observar los Runs vivos) y arranca el scheduler.
   */
  async start(): Promise<void> {
    await ensureMcpConfig(this.mcp.configPath, this.mcp.url);
    await ensureHookSettings(this.hooks.settingsPath, this.hooks.url);
    await this.dispatcher.recover();
    if (this.unsubscribes.length === 0 && this.publisher) {
      this.unsubscribes = [
        this.publisher.subscribe(TASK_TRANSITIONED, async (m) => {
          this.watcher.onTransition(m);
          this.reconciler.onMessage(m);
          const notification = escalationNotification(m);
          if (notification) await this.notify(notification);
          await this.onTransition(m);
        }),
        this.publisher.subscribe(TASK_PR_STATE_CHANGED, (m) => this.reconciler.onMessage(m)),
      ];
    }
    await this.reconciler.start();
    await this.scheduler.start();
  }

  /**
   * La tarea salió de running: si su último Run ya está cerrado (lo cerró una tool del MCP), se
   * limpia su pane. Idempotente, como pide el outbox (entrega al menos una vez).
   */
  async onTransition(message: OutboxMessage): Promise<void> {
    const payload = TaskTransitionedPayload.safeParse(message.payload);
    if (!payload.success) return;
    const { from, to } = payload.data;
    if (from.subState !== "running" || to.subState === "running") return;
    const run = this.runs.latestForTask(message.taskId);
    if (run?.endedAt) await this.dispatcher.releaseRun(run.id);
  }

  /** Detiene scheduler y reconciliación, espera los lanzamientos en curso y deja de observar. */
  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    await this.reconciler.stop();
    await this.scheduler.stop();
    await this.dispatcher.idle();
    await this.watcher.stop();
    this.notifications?.escalator.stop();
  }
}
