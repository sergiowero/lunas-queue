// Observation of live agents (docs/design.md §Signals and §Phase timeout, ADR
// uw-17-reconciliacion). It implements the dispatcher's `RunObserver`: for each launched Run it listens to
// its pane's state in herdr and its lifecycle, and applies the signal table:
// - `blocked` pauses the timeout and, if it stays that way 1 minute, notifies (Escalator, ADR 0009);
// - `idle`/`done` without the MCP end-of-phase signal: nudge N times and then failed Run;
// - pane closed or process finished: failed Run (retry with backoff or needs_human);
// - phase timeout expired: needs_human with notification; the agent stays alive.
// The database is the truth: before acting the Run and the task are re-read, so a late signal
// (the Run was already closed by an MCP tool) does nothing.
import type {
  AgentStatus,
  HerdrAdapter,
  HerdrAgent,
  HerdrEvent,
  HerdrSubscription,
} from "@lunasq/adapters";
import { showsUsageLimit, usageLimitMessage } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  ProjectRepository,
  RunRepository,
  type RunRow,
  TaskRepository,
  transitionTask,
} from "@lunasq/db";
import {
  nudgePrompt,
  type ProjectConfigReader,
  pendingPhase,
  phaseTimeoutMs,
} from "@lunasq/domain";
import {
  type BlockedAgent,
  type Notification,
  type OutboxMessage,
  type SchedulablePhase,
  SchedulablePhase as SchedulablePhaseSchema,
  TaskTransitionedPayload,
  taskLabel,
} from "@lunasq/schemas";
import type { RunObserver } from "../dispatcher/dispatcher.ts";
import type { Escalator } from "../notifications/escalator.ts";
import { KeyedLock } from "../worktrees/keyed-lock.ts";
import { PhaseClock } from "./phase-clock.ts";

/** Nudges before giving the Run as failed (docs/design.md §Signals: "N times"). */
export const DEFAULT_MAX_NUDGES = 2;
/**
 * How long to wait with the agent stopped before the nudge. It covers the exit tool that closes the
 * Run just before the agent finishes its turn.
 */
export const DEFAULT_NUDGE_GRACE_MS = 15_000;
/** Lines read from the agent to recognize the screen (the TUI draws the notice at the bottom). */
const SCREEN_LINES = 40;

export interface RunWatcherOptions {
  db: LunasqDatabase;
  herdr: HerdrAdapter;
  /** `PhaseDispatcher.failRun`: closes the Run, applies `run_failed` and closes the pane. */
  failRun: (runId: string, reason: string) => Promise<unknown>;
  escalator: Pick<Escalator, "watch" | "resolve">;
  notify: (notification: Notification) => unknown;
  projects?: ProjectConfigReader;
  /** herdr events were lost: whoever reconciles compares with the snapshot. */
  onLost?: () => void;
  maxNudges?: number;
  nudgeGraceMs?: number;
  onError?: (error: Error, runId: string | null) => void;
}

type Watch = {
  runId: string;
  taskId: string;
  /** Task number: the notification titles identify it with #N. */
  taskNumber: number;
  phase: SchedulablePhase;
  name: string;
  paneId: string;
  sub: HerdrSubscription;
  clock: PhaseClock;
  status: AgentStatus;
  nudges: number;
  /** Times the agent became `blocked`: builds the id of each notification (ADR 0009). */
  blocks: number;
  blockedId: string | undefined;
  blockedSince: Date | undefined;
  grace: ReturnType<typeof setTimeout> | undefined;
  /** The timeout already escalated: no more nudges or timeout, the pane is only watched to stay alive. */
  expired: boolean;
};

export class RunWatcher implements RunObserver {
  private readonly db: LunasqDatabase;
  private readonly herdr: HerdrAdapter;
  private readonly failRunFn: (runId: string, reason: string) => Promise<unknown>;
  private readonly escalator: Pick<Escalator, "watch" | "resolve">;
  private readonly notifyFn: (notification: Notification) => unknown;
  private readonly projects: ProjectConfigReader;
  private readonly onLost: () => void;
  private readonly maxNudges: number;
  private readonly nudgeGraceMs: number;
  private readonly onError: (error: Error, runId: string | null) => void;
  private readonly runs: RunRepository;
  private readonly tasks: TaskRepository;
  private readonly watches = new Map<string, Watch>();
  /** Signals of the same Run in order: each one re-reads the database before acting. */
  private readonly locks = new KeyedLock();
  private lifecycle: HerdrSubscription | undefined;

  constructor(opts: RunWatcherOptions) {
    this.db = opts.db;
    this.herdr = opts.herdr;
    this.failRunFn = opts.failRun;
    this.escalator = opts.escalator;
    this.notifyFn = opts.notify;
    this.projects = opts.projects ?? new ProjectRepository(opts.db);
    this.onLost = opts.onLost ?? (() => {});
    this.maxNudges = opts.maxNudges ?? DEFAULT_MAX_NUDGES;
    this.nudgeGraceMs = opts.nudgeGraceMs ?? DEFAULT_NUDGE_GRACE_MS;
    this.onError = opts.onError ?? defaultError;
    this.runs = new RunRepository(opts.db);
    this.tasks = new TaskRepository(opts.db);
  }

  /** Starts observing a launched Run. Repeating it with an already observed Run does nothing. */
  watch(run: RunRow, agent: HerdrAgent): void {
    if (this.watches.has(run.id) || run.endedAt !== null) return;
    const task = this.tasks.get(run.taskId);
    const project = task ? this.projects.get(task.projectId) : null;
    const phase = SchedulablePhaseSchema.safeParse(run.phase);
    if (!task || !project || !phase.success || !run.herdrName) {
      this.onError(new Error(`cannot observe Run ${run.id}`), run.id);
      return;
    }
    this.ensureLifecycle();
    const runId = run.id;
    const w: Watch = {
      runId,
      taskId: run.taskId,
      taskNumber: task.number,
      phase: phase.data,
      name: run.herdrName,
      paneId: agent.paneId,
      sub: this.herdr.subscribe({ paneIds: [agent.paneId] }, (event) =>
        this.onPaneEvent(runId, event),
      ),
      clock: new PhaseClock(phaseTimeoutMs(project, phase.data), () =>
        this.serial(runId, (w) => this.expire(w)),
      ),
      status: agent.status,
      nudges: 0,
      blocks: 0,
      blockedId: undefined,
      blockedSince: undefined,
      grace: undefined,
      expired: false,
    };
    this.watches.set(runId, w);
    if (task.subState === "waiting_human") w.clock.pause("waiting_human");
    w.clock.start();
    this.applyStatus(w, agent.status);
  }

  /** Stops observing the Run: the dispatcher calls it before closing its pane. Idempotent. */
  unwatch(runId: string): void {
    const w = this.watches.get(runId);
    if (!w) return;
    this.watches.delete(runId);
    w.clock.stop();
    clearTimeout(w.grace);
    if (w.blockedId) this.escalator.resolve(w.blockedId);
    w.sub.close().catch((e: unknown) => this.onError(asError(e), runId));
  }

  /**
   * Agents waiting for a permission in their TUI (herdr `blocked`): they are answered in herdr, in the agent's
   * pane. It is what the inbox shows as "blocked agent".
   */
  blocked(): BlockedAgent[] {
    return [...this.watches.values()].flatMap((w) =>
      w.blockedSince
        ? [
            {
              runId: w.runId,
              taskId: w.taskId,
              phase: w.phase,
              agentName: w.name,
              paneId: w.paneId,
              since: w.blockedSince.toISOString(),
            },
          ]
        : [],
    );
  }

  /** Runs observados. */
  watching(): string[] {
    return [...this.watches.keys()];
  }

  /**
   * Task transition (outbox): `waiting_human` pauses the timeout and the answer resumes it.
   * If the task leaves running by another route (timeout, cancellation), there are no more nudges or timeout.
   */
  onTransition(message: OutboxMessage): void {
    const payload = TaskTransitionedPayload.safeParse(message.payload);
    if (!payload.success) return;
    for (const w of this.watches.values()) {
      if (w.taskId !== message.taskId) continue;
      void this.serial(w.runId, async (w) => this.syncTask(w));
    }
  }

  async stop(): Promise<void> {
    for (const runId of [...this.watches.keys()]) this.unwatch(runId);
    const lifecycle = this.lifecycle;
    this.lifecycle = undefined;
    await lifecycle?.close();
  }

  // --- Signals ---

  private ensureLifecycle(): void {
    this.lifecycle ??= this.herdr.subscribe({ lifecycle: true }, (event) => {
      if (event.type === "events_lost") this.onLost();
      if (event.type !== "pane_closed" && event.type !== "pane_exited") return;
      for (const w of this.watches.values()) {
        if (w.paneId === event.paneId) {
          void this.serial(w.runId, (w) => this.gone(w, event.type === "pane_exited"));
        }
      }
    });
  }

  private onPaneEvent(runId: string, event: HerdrEvent): void {
    switch (event.type) {
      case "agent_status_changed":
        void this.serial(runId, async (w) => this.applyStatus(w, event.status));
        return;
      case "events_lost":
        // It may have changed state without the event arriving: it is re-read on reconnecting.
        this.onLost();
        return;
      case "subscribed":
        void this.serial(runId, async (w) => {
          const agent = await this.herdr.getAgent(w.name);
          if (!this.current(w)) return;
          if (!agent) return this.gone(w, true);
          this.applyStatus(w, agent.status);
        });
        return;
      case "subscription_failed":
        // Only `pane_not_found` says the pane no longer exists; any other error (protocol, herdr
        // restarting) is decided by reconciliation with the snapshot.
        if (event.code === "pane_not_found") void this.serial(runId, (w) => this.gone(w, false));
        else this.onLost();
        return;
      default:
        return;
    }
  }

  private applyStatus(w: Watch, status: AgentStatus): void {
    w.status = status;
    if (status !== "blocked" && w.blockedId) {
      this.escalator.resolve(w.blockedId);
      w.blockedId = undefined;
      w.blockedSince = undefined;
      w.clock.resume("blocked");
    }
    if (status === "blocked") {
      clearTimeout(w.grace);
      w.grace = undefined;
      if (!w.blockedId) {
        w.blocks += 1;
        w.blockedId = `blocked:${w.runId}:${w.blocks}`;
        w.blockedSince = new Date();
        w.clock.pause("blocked");
        this.escalator.watch({
          id: w.blockedId,
          kind: "agent_blocked",
          taskId: w.taskId,
          runId: w.runId,
          title: `Blocked agent in ${taskLabel(w.taskNumber)}`,
          body: `Agent ${w.name} (${w.phase}) has been waiting for a permission in herdr for 1 minute.`,
        });
        // The block may be the usage limit as a menu, not a permission: the
        // screen is read before the blocked notice matures (1 minute).
        void this.serial(w.runId, (w) => this.checkBlocked(w));
      }
    } else if (status === "idle" || status === "done") {
      if (w.grace === undefined && !w.expired) {
        w.grace = setTimeout(() => {
          w.grace = undefined;
          void this.serial(w.runId, (w) => this.stalled(w));
        }, this.nudgeGraceMs);
      }
    } else {
      clearTimeout(w.grace);
      w.grace = undefined;
    }
  }

  /**
   * Run the watcher must no longer fail or escalate: closed (an exit tool closed it and the
   * dispatcher releases the pane on seeing the transition) or with a saved handoff (the verifier gave
   * a pass and the delivery runs with the Run open, ADR 0007).
   */
  private settled(w: Watch): boolean {
    const run = this.runs.get(w.runId);
    return !run || run.endedAt !== null || run.handoff !== null;
  }

  /** The Watch is still the current one: after an await the dispatcher may have called `unwatch`. */
  private current(w: Watch): boolean {
    return this.watches.get(w.runId) === w;
  }

  /** The agent is still stopped without an MCP signal past the grace period: nudge or failed Run. */
  private async stalled(w: Watch): Promise<void> {
    if (w.expired || (w.status !== "idle" && w.status !== "done")) return;
    if (this.settled(w) || !this.inPhase(w, "running")) return;
    const agent = await this.herdr.getAgent(w.name);
    if (!this.current(w)) return;
    if (!agent) return this.gone(w, true);
    if (agent.status !== "idle" && agent.status !== "done")
      return this.applyStatus(w, agent.status);
    if (await this.usageLimit(w)) return;
    if (w.nudges < this.maxNudges) {
      w.nudges += 1;
      const prompted = await this.herdr.promptAgent({
        name: w.name,
        text: nudgePrompt(w.phase, w.taskId),
      });
      if (this.current(w)) this.applyStatus(w, prompted.status);
      return;
    }
    this.unwatch(w.runId);
    await this.failRunFn(
      w.runId,
      `agent_stopped: agent ${w.name} stopped without the end-of-phase signal after ${w.nudges} nudges`,
    );
  }

  /** On entering `blocked`: if the screen is the usage limit (not a permission), it escalates now. */
  private async checkBlocked(w: Watch): Promise<void> {
    if (w.expired || w.status !== "blocked" || this.settled(w)) return;
    await this.usageLimit(w);
  }

  /**
   * Claude's usage-limit notice is only seen on its screen (herdr does not detect it, ADR 0004):
   * if present, it pauses the task in needs_human until someone resumes it, with the Run and the agent
   * alive, like the phase timeout. Returns true if it detected and escalated.
   */
  private async usageLimit(w: Watch): Promise<boolean> {
    let screen: string;
    try {
      screen = await this.herdr.readAgent({ name: w.name, lines: SCREEN_LINES });
    } catch {
      return false; // the agent no longer responds: the next signal (crash) decides the route.
    }
    if (!this.current(w) || !showsUsageLimit(screen)) return false;
    await this.escalateUsageLimit(w, usageLimitMessage(screen));
    return true;
  }

  /** needs_human with `usage_limit` and notification; from then on only the pane is watched. */
  private async escalateUsageLimit(w: Watch, message: string): Promise<void> {
    const task = this.tasks.get(w.taskId);
    if (!task || this.settled(w) || !this.inPhase(w, "running")) return;
    w.expired = true;
    clearTimeout(w.grace);
    w.grace = undefined;
    if (w.blockedId) this.escalator.resolve(w.blockedId);
    w.blockedId = undefined;
    w.blockedSince = undefined;
    const moved = transitionTask(this.db, {
      taskId: w.taskId,
      actor: "system",
      command: {
        type: "escalate",
        reason: "usage_limit",
        note: `Agent ${w.name} (${w.phase}) ran out of usage: ${message}`,
      },
      expected: { state: task.state, subState: "running" },
    });
    if (!moved.ok) return;
    await this.notifyFn({
      id: `usage:${w.runId}`,
      kind: "usage_limit",
      taskId: w.taskId,
      runId: w.runId,
      title: `Usage limit in ${w.taskId.slice(0, 8)}`,
      body: `Agent ${w.name} (${w.phase}) reached its usage limit ("${message}"). The task waits in needs_human: resume it when the limit resets.`,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * The pane closed or the agent left: failed Run if it is still open. In waiting_human the Run is
   * left open: it occupies its slot on purpose (ADR 0014) and the answer relaunches.
   */
  private async gone(w: Watch, exited: boolean): Promise<void> {
    this.unwatch(w.runId);
    if (this.settled(w) || this.inPhase(w, "waiting_human")) return;
    const what = exited ? "the agent process ended" : "the pane was closed";
    await this.failRunFn(w.runId, `agent_exited: ${what} (${w.name}, pane ${w.paneId})`);
  }

  /** Phase timeout expired: needs_human with notification; the agent stays alive. */
  private async expire(w: Watch): Promise<void> {
    if (this.inPhase(w, "waiting_human")) {
      // It expired with the question open before the outbox paused the clock: it stays paused
      // without budget and expires as soon as the answer resumes it.
      w.clock = new PhaseClock(0, () => this.serial(w.runId, (w) => this.expire(w)));
      w.clock.pause("waiting_human");
      w.clock.start();
      return;
    }
    w.expired = true;
    clearTimeout(w.grace);
    w.grace = undefined;
    const task = this.tasks.get(w.taskId);
    if (!task || this.settled(w) || !this.inPhase(w, "running")) return;
    const project = this.projects.get(task.projectId);
    const minutes = project ? phaseTimeoutMs(project, w.phase) / 60_000 : undefined;
    const moved = transitionTask(this.db, {
      taskId: w.taskId,
      actor: "system",
      command: {
        type: "escalate",
        reason: "phase_timeout",
        note: `Phase ${w.phase} exceeded its timeout${minutes ? ` of ${minutes} min` : ""}; agent ${w.name} is still alive in herdr.`,
      },
      expected: { state: task.state, subState: "running" },
    });
    if (!moved.ok) return;
    await this.notifyFn({
      id: `timeout:${w.runId}`,
      kind: "phase_timeout",
      taskId: w.taskId,
      runId: w.runId,
      title: `Phase timeout in ${taskLabel(w.taskNumber)}`,
      body: `Phase ${w.phase} exceeded its timeout${minutes ? ` of ${minutes} min` : ""}. Agent ${w.name} is still alive: wait, step in on herdr or cancel.`,
      createdAt: new Date().toISOString(),
    });
  }

  /** Aligns the clock with the task's sub-state. */
  private syncTask(w: Watch): void {
    const task = this.tasks.get(w.taskId);
    if (task && pendingPhase(task.state) === w.phase && task.subState === "waiting_human") {
      w.clock.pause("waiting_human");
      clearTimeout(w.grace);
      w.grace = undefined;
      return;
    }
    if (this.inPhase(w, "running")) {
      w.clock.resume("waiting_human");
      // After an answer the agent may still be stopped: it counts the grace period again.
      this.applyStatus(w, w.status);
      return;
    }
    // It left the phase (timeout, cancellation, needs_human): only the pane is watched.
    w.expired = true;
    w.clock.stop();
    clearTimeout(w.grace);
    w.grace = undefined;
  }

  private inPhase(w: Watch, subState: "running" | "waiting_human"): boolean {
    const task = this.tasks.get(w.taskId);
    return task !== null && pendingPhase(task.state) === w.phase && task.subState === subState;
  }

  /** Runs `fn` in order with the Run's other signals, if it is still observed. */
  private serial(runId: string, fn: (w: Watch) => Promise<void> | void): Promise<void> {
    return this.locks
      .run(runId, async () => {
        const w = this.watches.get(runId);
        if (w) await fn(w);
      })
      .catch((error: unknown) => this.onError(asError(error), runId));
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultError(error: Error, runId: string | null): void {
  console.error(`[watcher] failure in ${runId ? `Run ${runId}` : "observation"}: ${error.message}`);
}
