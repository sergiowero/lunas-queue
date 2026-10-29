// Composición de scheduler y dispatcher en el proceso del servidor (ADR 0014, consecuencias para
// UW-16): el dispatcher implementa el puerto del scheduler y ambos comparten límites. El
// publicador del outbox lo arranca quien lo crea; aquí solo se le suscribe el scheduler.
import type { HerdrAdapter, ProcessRunner } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  ProjectRepository,
  ProjectWorkspaceRepository,
  TaskWorktreeRepository,
} from "@lunasq/db";
import type { SchedulerConfigInput } from "@lunasq/schemas";
import type { OutboxPublisher } from "../outbox/publisher.ts";
import { Scheduler, type SchedulerErrorHandler } from "../scheduler/scheduler.ts";
import { WorktreeService } from "../worktrees/service.ts";
import { type DispatchErrorHandler, PhaseDispatcher, type RunObserver } from "./dispatcher.ts";
import { ensureMcpConfig } from "./mcp-config.ts";

export interface OrchestratorOptions {
  db: LunasqDatabase;
  herdr: HerdrAdapter;
  processes: ProcessRunner;
  /** Archivo MCP estable y URL del LunasQ MCP que escribe al arrancar (ADR 0002). */
  mcp: { configPath: string; url: string };
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

  constructor(opts: OrchestratorOptions) {
    const projects = new ProjectRepository(opts.db);
    this.mcp = opts.mcp;
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

  /** Escribe el archivo MCP, retoma los despachos a medias y arranca el scheduler. */
  async start(): Promise<void> {
    await ensureMcpConfig(this.mcp.configPath, this.mcp.url);
    await this.dispatcher.recover();
    await this.scheduler.start();
  }

  /** Detiene el scheduler y espera los lanzamientos en curso. */
  async stop(): Promise<void> {
    await this.scheduler.stop();
    await this.dispatcher.idle();
  }
}
