// Loop de reconciliación (docs/design.md §Loop de reconciliación, ADR uw-17-reconciliacion). Cada
// N segundos, al arrancar y cuando se pierden eventos de herdr: toma `session.snapshot`, lo compara
// con los Runs abiertos en la base y corrige. La base es la verdad y herdr es efímero, así que cada
// corrección es idempotente: repetir una pasada no duplica efectos.
// - Run lanzado sin su agente en herdr → Run fallido (reintento con backoff o needs_human).
// - Run reclamado sin lanzar → el dispatcher lo retoma.
// - Run abierto de una tarea que salió de su fase (cancelada, reanudada tras un timeout) → se
//   cierra como cancelled y se libera su pane.
// - Run vivo que nadie observa (tras un reinicio) → se vuelve a observar.
// - Agente con nombre de LunasQ sin Run abierto → se cierra su pane (huérfano).
// - Tarea cancelada o mergeada que conserva su worktree → se remueve; y cada tanto, los worktrees
//   huérfanos de cada proyecto (ADR 0012).
import type { HerdrAdapter, HerdrAgent } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  ProjectRepository,
  RunRepository,
  TaskRepository,
  TaskWorktreeRepository,
} from "@lunasq/db";
import { isAgentName, type ProjectConfigReader, pendingPhase } from "@lunasq/domain";
import {
  type OutboxMessage,
  TASK_PR_STATE_CHANGED,
  TASK_TRANSITIONED,
  TaskPrStateChangedPayload,
  TaskTransitionedPayload,
} from "@lunasq/schemas";
import type { PhaseDispatcher } from "../dispatcher/dispatcher.ts";
import type { WorktreeService } from "../worktrees/service.ts";
import type { RunWatcher } from "./watcher.ts";

export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
/** Cada cuántas pasadas se buscan worktrees huérfanos: cada búsqueda lista el repo en herdr. */
export const DEFAULT_ORPHAN_WORKTREES_EVERY = 10;

export type ReconcileResult = {
  /** Runs dados por fallidos porque su agente ya no está en herdr. */
  failed: string[];
  /** Runs cerrados porque su tarea salió de la fase. */
  closed: string[];
  /** Runs vivos que se volvieron a observar. */
  watched: string[];
  /** Panes cerrados por tener un agente de LunasQ sin Run. */
  orphanPanes: string[];
  /** Tareas cuyo worktree se removió. */
  removedWorktrees: string[];
};

export type ReconcileErrorHandler = (error: Error, subject: string | null) => void;

export interface ReconcilerOptions {
  db: LunasqDatabase;
  herdr: HerdrAdapter;
  dispatcher: Pick<PhaseDispatcher, "recover" | "failRun" | "closeRun">;
  watcher: Pick<RunWatcher, "watch" | "watching">;
  worktrees: Pick<WorktreeService, "remove" | "cleanupOrphans">;
  projects?: ProjectConfigReader;
  intervalMs?: number;
  orphanWorktreesEvery?: number;
  onError?: ReconcileErrorHandler;
}

export class Reconciler {
  private readonly herdr: HerdrAdapter;
  private readonly dispatcher: ReconcilerOptions["dispatcher"];
  private readonly watcher: ReconcilerOptions["watcher"];
  private readonly worktrees: ReconcilerOptions["worktrees"];
  private readonly projects: ProjectConfigReader;
  private readonly intervalMs: number;
  private readonly orphanWorktreesEvery: number;
  private readonly onError: ReconcileErrorHandler;
  private readonly runs: RunRepository;
  private readonly tasks: TaskRepository;
  private readonly taskWorktrees: TaskWorktreeRepository;
  private running: Promise<ReconcileResult> | undefined;
  private rerun = false;
  private stopped = false;
  private passes = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Worktrees que no se pudieron remover (p. ej. con cambios): se reporta una vez. */
  private readonly reported = new Set<string>();

  constructor(opts: ReconcilerOptions) {
    this.herdr = opts.herdr;
    this.dispatcher = opts.dispatcher;
    this.watcher = opts.watcher;
    this.worktrees = opts.worktrees;
    this.projects = opts.projects ?? new ProjectRepository(opts.db);
    this.intervalMs = opts.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.orphanWorktreesEvery = opts.orphanWorktreesEvery ?? DEFAULT_ORPHAN_WORKTREES_EVERY;
    this.onError = opts.onError ?? defaultError;
    this.runs = new RunRepository(opts.db);
    this.tasks = new TaskRepository(opts.db);
    this.taskWorktrees = new TaskWorktreeRepository(opts.db);
  }

  /** Una pasada (o se une a la que corre y pide otra), como el scheduler. */
  run(): Promise<ReconcileResult> {
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

  /** Pide una pasada sin esperarla: al perder eventos de herdr o al ver una transición. */
  wake(): void {
    this.run().catch((error: unknown) => this.onError(asError(error), null));
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.timer ??= setInterval(() => this.wake(), this.intervalMs);
    await this.run().catch((error: unknown) => this.onError(asError(error), null));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }

  /**
   * Outbox: una cancelación, una reanudación o un merge piden pasada ya, sin esperar al tick
   * (detener el agente de una tarea cancelada, ADR 0010; remover su worktree, ADR 0012).
   */
  onMessage(message: OutboxMessage): void {
    if (message.topic === TASK_TRANSITIONED) {
      const payload = TaskTransitionedPayload.safeParse(message.payload);
      if (!payload.success) return;
      const { command } = payload.data;
      if (command === "cancel" || command === "resume") this.wake();
    } else if (message.topic === TASK_PR_STATE_CHANGED) {
      const payload = TaskPrStateChangedPayload.safeParse(message.payload);
      if (payload.success && payload.data.to === "merged") this.wake();
    }
  }

  private async loop(): Promise<ReconcileResult> {
    let result = emptyResult();
    do {
      this.rerun = false;
      if (this.stopped) break;
      result = await this.pass();
    } while (this.rerun);
    return result;
  }

  private async pass(): Promise<ReconcileResult> {
    this.passes += 1;
    const result = emptyResult();
    const snap = await this.herdr.snapshot();
    // Después del snapshot: todo agente del snapshot fue arrancado por un Run que ya existe aquí.
    const active = this.runs.active();
    await this.dispatcher.recover();
    const watching = new Set(this.watcher.watching());

    for (const run of active) {
      if (run.launchedAt === null) continue;
      await this.guard(run.id, async () => {
        const task = this.tasks.get(run.taskId);
        // Con handoff guardado el verificador dio pass y la entrega corre con su Run abierto:
        // no es un Run caído (ADR 0007).
        if (!task || run.handoff !== null) return;
        const agent = snap.agents.find((a) => a.name === run.herdrName);
        const alive = agent !== undefined && agent.paneId === run.herdrPane;
        // needs_human (p. ej. timeout): el agente sigue vivo a propósito para el humano.
        if (task.state === "needs_human") {
          if (alive && !watching.has(run.id)) this.rewatch(run, agent, result);
          return;
        }
        const inPhase =
          pendingPhase(task.state) === run.phase &&
          (task.subState === "running" || task.subState === "waiting_human");
        if (!inPhase) {
          await this.dispatcher.closeRun(run.id, {
            result: "cancelled",
            failureReason: `task_left_phase: la tarea está en ${task.state}/${task.subState ?? "-"}`,
          });
          result.closed.push(run.id);
          return;
        }
        if (alive) {
          if (!watching.has(run.id)) this.rewatch(run, agent, result);
          return;
        }
        // waiting_human ocupa su slot a propósito (ADR 0014); la respuesta relanza (UW-22).
        if (task.subState === "waiting_human") return;
        const res = await this.dispatcher.failRun(
          run.id,
          `agent_lost: el agente ${run.herdrName ?? "?"} no está en herdr (pane ${run.herdrPane ?? "?"})`,
        );
        if (res.closed) result.failed.push(run.id);
      });
    }

    const owned = new Set(active.map((r) => r.herdrName).filter((n) => n !== null));
    for (const agent of snap.agents) {
      if (!isAgentName(agent.name) || owned.has(agent.name)) continue;
      await this.guard(agent.name, async () => {
        await this.herdr.closePane(agent.paneId);
        result.orphanPanes.push(agent.paneId);
      });
    }

    for (const task of this.taskWorktrees.releasable()) {
      await this.guard(task.id, async () => {
        try {
          const { removed } = await this.worktrees.remove(task.id);
          if (removed) result.removedWorktrees.push(task.id);
          this.reported.delete(task.id);
        } catch (error) {
          if (this.reported.has(task.id)) return;
          this.reported.add(task.id);
          throw error;
        }
      });
    }

    if (this.passes % this.orphanWorktreesEvery === 1 || this.orphanWorktreesEvery === 1) {
      for (const project of this.projects.list()) {
        await this.guard(project.id, async () => {
          const cleanup = await this.worktrees.cleanupOrphans(project.id);
          for (const failure of cleanup.failed) {
            this.onError(new Error(`${failure.code}: ${failure.path}`), project.id);
          }
        });
      }
    }
    return result;
  }

  private rewatch(run: Parameters<RunWatcher["watch"]>[0], agent: HerdrAgent, r: ReconcileResult) {
    this.watcher.watch(run, agent);
    r.watched.push(run.id);
  }

  /** Un fallo en un elemento se reporta y no detiene la pasada. */
  private async guard(subject: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.onError(asError(error), subject);
    }
  }
}

function emptyResult(): ReconcileResult {
  return { failed: [], closed: [], watched: [], orphanPanes: [], removedWorktrees: [] };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultError(error: Error, subject: string | null): void {
  console.error(`[reconciler] fallo${subject ? ` en ${subject}` : ""}: ${error.message}`);
}
