// Composición de scheduler y dispatcher en el proceso del servidor (ADR 0014, consecuencias para
// UW-16): el dispatcher implementa el puerto del scheduler y ambos comparten límites. El
// publicador del outbox lo arranca quien lo crea; aquí solo se le suscribe el scheduler.
import type { HerdrAdapter, ProcessRunner } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  ProjectRepository,
  ProjectWorkspaceRepository,
  RunRepository,
  TaskWorktreeRepository,
} from "@lunasq/db";
import {
  type OutboxMessage,
  type SchedulerConfigInput,
  TASK_TRANSITIONED,
  TaskTransitionedPayload,
} from "@lunasq/schemas";
import type { OutboxPublisher } from "../outbox/publisher.ts";
import { Scheduler, type SchedulerErrorHandler } from "../scheduler/scheduler.ts";
import { WorktreeService } from "../worktrees/service.ts";
import { type DispatchErrorHandler, PhaseDispatcher, type RunObserver } from "./dispatcher.ts";
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
  observer?: RunObserver;
  onDispatchError?: DispatchErrorHandler;
  onSchedulerError?: SchedulerErrorHandler;
}

export class Orchestrator {
  readonly worktrees: WorktreeService;
  readonly dispatcher: PhaseDispatcher;
  readonly scheduler: Scheduler;
  private readonly mcp: { configPath: string; url: string };
  private readonly hooks: { settingsPath: string; url: string };
  private readonly publisher: OutboxPublisher | undefined;
  private readonly runs: RunRepository;
  private unsubscribe: (() => void) | undefined;

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
    this.dispatcher = new PhaseDispatcher({
      db: opts.db,
      herdr: opts.herdr,
      worktrees: this.worktrees,
      projects,
      mcpConfigPath: opts.mcp.configPath,
      hookSettingsPath: opts.hooks.settingsPath,
      ...(opts.config && { config: opts.config }),
      ...(opts.paneEnv && { paneEnv: opts.paneEnv }),
      ...(opts.observer && { observer: opts.observer }),
      ...(opts.onDispatchError && { onError: opts.onDispatchError }),
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

  /** Escribe los archivos MCP y de hooks, retoma los despachos a medias y arranca el scheduler. */
  async start(): Promise<void> {
    await ensureMcpConfig(this.mcp.configPath, this.mcp.url);
    await ensureHookSettings(this.hooks.settingsPath, this.hooks.url);
    await this.dispatcher.recover();
    this.unsubscribe ??= this.publisher?.subscribe(TASK_TRANSITIONED, (m) => this.onTransition(m));
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

  /** Detiene el scheduler y espera los lanzamientos en curso. */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.scheduler.stop();
    await this.dispatcher.idle();
  }
}
