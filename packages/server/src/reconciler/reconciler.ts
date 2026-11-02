// Reconciliation loop (docs/design.md §Reconciliation loop, ADR uw-17-reconciliacion). Every
// N seconds, on start and when herdr events are lost: takes `session.snapshot`, compares it
// with the open Runs in the database and corrects. The database is the truth and herdr is ephemeral, so each
// correction is idempotent: repeating a pass does not duplicate effects.
// - Launched Run without its agent in herdr → failed Run (retry with backoff or needs_human).
// - Claimed Run not launched → the dispatcher resumes it.
// - Open Run of a task that left its phase (canceled, paused, resumed after a timeout) → it is
//   closed as cancelled and its pane is released.
// - Live Run nobody watches (after a restart) → it is watched again.
// - Agent with a LunasQ name without an open Run → its pane is closed (orphan).
// - Canceled or merged task that keeps its worktree → it is removed; and every so often, the orphan
//   worktrees of each project (ADR 0012).
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
/** Every how many passes orphan worktrees are looked for: each search lists the repo in herdr. */
export const DEFAULT_ORPHAN_WORKTREES_EVERY = 10;

export type ReconcileResult = {
  /** Runs given as failed because their agent is no longer in herdr. */
  failed: string[];
  /** Runs closed because their task left the phase. */
  closed: string[];
  /** Live Runs that were observed again. */
  watched: string[];
  /** Panes closed for having a LunasQ agent without a Run. */
  orphanPanes: string[];
  /** Tasks whose worktree was removed. */
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
  /** Runs were closed: the scheduler can dispatch what was resumed right away (`resume` after a timeout). */
  onRunsClosed?: () => void;
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
  private readonly onRunsClosed: () => void;
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
  /** Worktrees that could not be removed (e.g. with changes): reported once. */
  private readonly reported = new Set<string>();

  constructor(opts: ReconcilerOptions) {
    this.herdr = opts.herdr;
    this.dispatcher = opts.dispatcher;
    this.watcher = opts.watcher;
    this.worktrees = opts.worktrees;
    this.projects = opts.projects ?? new ProjectRepository(opts.db);
    this.onRunsClosed = opts.onRunsClosed ?? (() => {});
    this.intervalMs = opts.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.orphanWorktreesEvery = opts.orphanWorktreesEvery ?? DEFAULT_ORPHAN_WORKTREES_EVERY;
    this.onError = opts.onError ?? defaultError;
    this.runs = new RunRepository(opts.db);
    this.tasks = new TaskRepository(opts.db);
    this.taskWorktrees = new TaskWorktreeRepository(opts.db);
  }

  /** One pass (or joins the one running and asks for another), like the scheduler. */
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

  /** Requests a pass without waiting for it: on losing herdr events or on seeing a transition. */
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
   * Outbox: a cancellation, pause, resumption, Result or merge request a pass right away, without waiting
   * for the tick (stopping the agent of a canceled or paused task, ADR 0010; removing its worktree, ADR 0012).
   */
  onMessage(message: OutboxMessage): void {
    if (message.topic === TASK_TRANSITIONED) {
      const payload = TaskTransitionedPayload.safeParse(message.payload);
      if (!payload.success) return;
      const { command } = payload.data;
      if (
        command === "cancel" ||
        command === "pause" ||
        command === "resume" ||
        command === "submit_result"
      ) {
        this.wake();
      }
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
    // After the snapshot: every agent in the snapshot was started by a Run that already exists here.
    const active = this.runs.active();
    const watching = new Set(this.watcher.watching());

    for (const listed of active) {
      await this.guard(listed.id, async () => {
        // It is re-read: the pass's earlier corrections wait on herdr and the Run may have
        // closed or saved its handoff in the meantime.
        const run = this.runs.get(listed.id);
        const task = run && this.tasks.get(run.taskId);
        // With a saved handoff the verifier gave a pass and the delivery runs with its Run open:
        // it is not a fallen Run (ADR 0007).
        if (!run || run.endedAt !== null || !task || run.handoff !== null) return;
        const inPhase =
          pendingPhase(task.state) === run.phase &&
          (task.subState === "running" || task.subState === "waiting_human");
        // needs_human (e.g. timeout): the agent stays alive on purpose for the human.
        if (task.state === "needs_human") {
          if (run.launchedAt === null) return;
          const agent = snap.agents.find((a) => a.name === run.herdrName);
          if (agent?.paneId === run.herdrPane && !watching.has(run.id)) {
            this.rewatch(run, agent, result);
          }
          return;
        }
        if (!inPhase) {
          // Also a claimed Run that never launched: its launch stops at the next step.
          await this.dispatcher.closeRun(run.id, {
            result: "cancelled",
            failureReason: `task_left_phase: the task is in ${task.state}/${task.subState ?? "-"}`,
          });
          result.closed.push(run.id);
          return;
        }
        if (run.launchedAt === null) return;
        const listedAgent = snap.agents.find((a) => a.name === run.herdrName);
        // The snapshot may have been taken before the launch started the agent: it is confirmed.
        const agent =
          listedAgent?.paneId === run.herdrPane
            ? listedAgent
            : run.herdrName
              ? await this.herdr.getAgent(run.herdrName)
              : undefined;
        if (agent && agent.paneId === run.herdrPane) {
          if (!watching.has(run.id)) this.rewatch(run, agent, result);
          return;
        }
        // waiting_human occupies its slot on purpose (ADR 0014); the answer relaunches (UW-22).
        if (task.subState === "waiting_human") return;
        const res = await this.dispatcher.failRun(
          run.id,
          `agent_lost: agent ${run.herdrName ?? "?"} is not in herdr (pane ${run.herdrPane ?? "?"})`,
        );
        if (res.closed) result.failed.push(run.id);
      });
    }
    // After closing the Runs of tasks that left their phase: this way they are not relaunched.
    await this.dispatcher.recover();

    const owned = new Set(active.map((r) => r.herdrName).filter((n) => n !== null));
    for (const agent of snap.agents) {
      if (!isAgentName(agent.name) || owned.has(agent.name)) continue;
      await this.guard(agent.name, async () => {
        await this.herdr.closePane(agent.paneId);
        result.orphanPanes.push(agent.paneId);
      });
    }

    for (const task of this.taskWorktrees.releasable()) {
      // With a Run still open (a launch that is stopping) another pass is waited for.
      if (this.runs.latestForTask(task.id)?.endedAt === null) continue;
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
    if (result.closed.length > 0 || result.failed.length > 0) this.onRunsClosed();
    return result;
  }

  private rewatch(run: Parameters<RunWatcher["watch"]>[0], agent: HerdrAgent, r: ReconcileResult) {
    this.watcher.watch(run, agent);
    r.watched.push(run.id);
  }

  /** A failure in an element is reported and does not stop the pass. */
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
