// Scheduler rules (docs/design.md §Scheduler, ADR 0014). Pure TypeScript: the caller reads a
// snapshot of the tasks and the DAG; here the ready set, the score and what is dispatched are computed
// without exceeding any concurrency limit. No preemption: only the free slots are distributed.
import type {
  AgentKind,
  AgentProviderSettings,
  Project,
  PrState,
  ResultKind,
  SchedulablePhase,
  SchedulerConfig,
  StatePosition,
  SubState,
  TaskState,
} from "@lunasq/schemas";
import { type DependencyEdge, DependencyGraph } from "./dependency-graph.ts";
import { type ProjectConfigReader, phaseProfile } from "./project-config.ts";
import { ALL_PROVIDERS_ENABLED, effectiveAgentKind } from "./providers.ts";
import { isTerminal } from "./state-machine.ts";

/** What the scheduler needs from a task. */
export type SchedulerTask = {
  id: string;
  projectId: string;
  state: TaskState;
  subState: SubState | null;
  /** Base priority captured by the human; the effective one is computed. */
  priority: number;
  prState: PrState | null;
  /** Result of a task completed without code (submit_result); null or absent if it has none. */
  resultKind?: ResultKind | null;
  createdAt: Date;
  /** Since when the task has waited in its current position: the base of aging. */
  readySince: Date;
  /** Consecutive failed Runs of its pending phase and when the last one ended: base of the backoff. */
  retry?: RetryState;
  /** Provider its live agent runs with (that of the open Run, which may be a fallback). */
  agentKind?: AgentKind;
};

export type RetryState = { failures: number; lastFailedAt: Date };

/**
 * Live (non-terminal) tasks, the terminal ones that some live task depends on, and the edges.
 * the live ones.
 */
export type SchedulerSnapshot = { tasks: SchedulerTask[]; edges: DependencyEdge[] };

/** Read port: the scheduler takes a snapshot per pass. */
export interface SchedulerStateReader {
  snapshot(): SchedulerSnapshot;
}

export type DispatchDecision = {
  taskId: string;
  projectId: string;
  phase: SchedulablePhase;
  agentKind: AgentKind;
  score: number;
  /** Position read; the claim uses it to reject if the task has already moved. */
  expected: StatePosition;
};

/** Dependent of a task that will no longer be delivered (PR closed without merge or cancelled). */
export type DependencyEscalation = {
  taskId: string;
  dependsOnId: string;
  expected: StatePosition;
};

export type SchedulePlan = { dispatch: DispatchDecision[]; escalate: DependencyEscalation[] };

export type RankedTask = { task: SchedulerTask; effectivePriority: number; score: number };

const PHASE_BY_STATE: Partial<Record<TaskState, SchedulablePhase>> = {
  draft: "refine",
  in_progress: "implement",
  verification: "verify",
};

/** Phase whose agent a task in this state awaits; null if the state carries no agent. */
export function pendingPhase(state: TaskState): SchedulablePhase | null {
  return PHASE_BY_STATE[state] ?? null;
}

const HOUR_MS = 3_600_000;

/**
 * When a task may be dispatched again after `failures` consecutive failed Runs:
 * `retryBackoffMs·2^(failures-1)` from the last failure, capped at `maxRetryBackoffMs`.
 * null if there are no failures to wait for.
 */
export function retryAt(retry: RetryState | undefined, config: SchedulerConfig): Date | null {
  if (!retry || retry.failures < 1) return null;
  // The exponent is bounded before computing: 2^40 already exceeds any reasonable cap.
  const wait = Math.min(
    config.retryBackoffMs * 2 ** Math.min(retry.failures - 1, 40),
    config.maxRetryBackoffMs,
  );
  return new Date(retry.lastFailedAt.getTime() + wait);
}

/** Live agent: running, or waiting_human (the question can be answered with the agent alive). */
function holdsSlot(task: SchedulerTask): boolean {
  return (
    pendingPhase(task.state) !== null &&
    (task.subState === "running" || task.subState === "waiting_human")
  );
}

/** A dependency is satisfied by its merged PR or by being completed with a Result (ADR 0007). */
function satisfies(dep: SchedulerTask | undefined): boolean {
  if (!dep) return false;
  return dep.prState === "merged" || (dep.state === "completed" && Boolean(dep.resultKind));
}

/** A dependency that will no longer be delivered: its dependent would wait forever. */
function failed(dep: SchedulerTask): boolean {
  return dep.prState === "closed" || (dep.state === "cancelled" && dep.prState !== "merged");
}

/**
 * Ready set ordered by score, from highest to lowest; ties by age and then by id.
 * score = effective priority + aging + boost. The effective priority inherits the highest base
 * priority of the live tasks that the task blocks; the boost counts those tasks.
 */
export function rankReady(
  snapshot: SchedulerSnapshot,
  config: SchedulerConfig,
  now: Date,
): RankedTask[] {
  const byId = new Map(snapshot.tasks.map((t) => [t.id, t]));
  const graph = DependencyGraph.from(snapshot.edges);
  const ranked: RankedTask[] = [];
  for (const task of snapshot.tasks) {
    if (pendingPhase(task.state) === null || task.subState !== "queued") continue;
    const retryTime = retryAt(task.retry, config);
    if (retryTime && retryTime.getTime() > now.getTime()) continue;
    if (!graph.dependenciesOf(task.id).every((id) => satisfies(byId.get(id)))) continue;

    const blocked = graph
      .descendants(task.id)
      .map((id) => byId.get(id))
      .filter((t): t is SchedulerTask => t !== undefined && !isTerminal(t.state));
    const effectivePriority = Math.max(task.priority, ...blocked.map((t) => t.priority));
    const hoursReady = Math.max(0, now.getTime() - task.readySince.getTime()) / HOUR_MS;
    const score =
      effectivePriority +
      config.agingPointsPerHour * hoursReady +
      config.boostPerDescendant * blocked.length;
    ranked.push({ task, effectivePriority, score });
  }
  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.task.createdAt.getTime() - b.task.createdAt.getTime() ||
      (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0),
  );
}

/** Counter of live agents per key against its limit (without a limit, it always fits). */
class Slots<K> {
  readonly #used = new Map<K, number>();

  add(key: K): void {
    this.#used.set(key, (this.#used.get(key) ?? 0) + 1);
  }

  fits(key: K, limit: number | undefined): boolean {
    return limit === undefined || (this.#used.get(key) ?? 0) < limit;
  }
}

/** A live or to-be-dispatched agent; `agentKind` is missing without project configuration or without an enabled provider. */
export type Slot = { projectId: string; phase: SchedulablePhase; agentKind: AgentKind | undefined };

/**
 * Live agents per limit level. `schedule` uses it to plan and the dispatcher claim
 * to revalidate with a fresh snapshot, with the same rules.
 */
export class Occupancy {
  #global = 0;
  readonly #byProject = new Slots<string>();
  readonly #byPhase = new Slots<SchedulablePhase>();
  readonly #byKind = new Slots<AgentKind>();
  readonly #projects: (id: string) => Project | null;
  readonly #providers: AgentProviderSettings;

  private constructor(
    projects: Pick<ProjectConfigReader, "get">,
    providers: AgentProviderSettings,
  ) {
    this.#projects = memo((id: string) => projects.get(id));
    this.#providers = providers;
  }

  /**
   * Occupancy of the snapshot's live agents. `providers` are the currently enabled providers
   * (all by default) and only affect new slots: a live agent counts against the provider
   * it runs with (`agentKind` of its Run; without it, the primary of its profile), because changing the
   * configuration never interrupts it.
   */
  static of(
    snapshot: SchedulerSnapshot,
    projects: Pick<ProjectConfigReader, "get">,
    providers: AgentProviderSettings = ALL_PROVIDERS_ENABLED,
  ): Occupancy {
    const occupancy = new Occupancy(projects, providers);
    for (const task of snapshot.tasks) {
      const phase = pendingPhase(task.state);
      if (!phase || !holdsSlot(task)) continue;
      const slot = occupancy.#slot(task, phase, ALL_PROVIDERS_ENABLED);
      occupancy.add(task.agentKind ? { ...slot, agentKind: task.agentKind } : slot);
    }
    return occupancy;
  }

  /**
   * The slot `task` would take in `phase`: the effective provider of the project profile (the
   * primary if enabled, otherwise the first enabled one of the fallback). `agentKind` is missing if the
   * project has no configuration or if no provider is enabled.
   */
  slotFor(task: Pick<SchedulerTask, "projectId">, phase: SchedulablePhase): Slot {
    return this.#slot(task, phase, this.#providers);
  }

  #slot(
    task: Pick<SchedulerTask, "projectId">,
    phase: SchedulablePhase,
    providers: AgentProviderSettings,
  ): Slot {
    const settings = this.#projects(task.projectId);
    const primary = settings ? phaseProfile(settings, phase).kind : undefined;
    return {
      projectId: task.projectId,
      phase,
      agentKind: primary ? (effectiveAgentKind(primary, providers) ?? undefined) : undefined,
    };
  }

  add(slot: Slot): void {
    this.#global += 1;
    this.#byProject.add(slot.projectId);
    this.#byPhase.add(slot.phase);
    if (slot.agentKind) this.#byKind.add(slot.agentKind);
  }

  globalFull(config: SchedulerConfig): boolean {
    return this.#global >= config.globalConcurrency;
  }

  /** Whether one more agent in `slot` fits at the four levels; without project configuration, no. */
  fits(slot: Slot, config: SchedulerConfig): boolean {
    const settings = this.#projects(slot.projectId);
    if (!settings || !slot.agentKind) return false;
    return (
      !this.globalFull(config) &&
      this.#byProject.fits(slot.projectId, settings.limits.concurrency) &&
      this.#byPhase.fits(slot.phase, config.phaseConcurrency[slot.phase]) &&
      this.#byKind.fits(slot.agentKind, config.agentKindConcurrency[slot.agentKind])
    );
  }
}

/**
 * What to dispatch and what to escalate in this pass. The decisions respect, added to the live
 * agents of the snapshot, the global, per-project, per-phase and per-agent-kind limits. Only
 * enabled providers are dispatched to (all by default): if the primary is disabled the first
 * enabled one of the fallback is used and, with none, nothing is dispatched.
 */
export function schedule(
  snapshot: SchedulerSnapshot,
  projects: Pick<ProjectConfigReader, "get">,
  config: SchedulerConfig,
  now: Date,
  providers: AgentProviderSettings = ALL_PROVIDERS_ENABLED,
): SchedulePlan {
  const occupancy = Occupancy.of(snapshot, projects, providers);
  const dispatch: DispatchDecision[] = [];
  for (const { task, score } of rankReady(snapshot, config, now)) {
    if (occupancy.globalFull(config)) break;
    const slot = occupancy.slotFor(task, pendingPhase(task.state) as SchedulablePhase);
    if (!slot.agentKind || !occupancy.fits(slot, config)) continue;
    occupancy.add(slot);
    dispatch.push({
      taskId: task.id,
      projectId: task.projectId,
      phase: slot.phase,
      agentKind: slot.agentKind,
      score,
      expected: { state: task.state, subState: task.subState },
    });
  }
  return { dispatch, escalate: blockedForever(snapshot) };
}

/**
 * Live dependents with a dependency that will no longer be delivered. Those in
 * needs_human or paused are omitted (escalate is rejected in paused) and those with a live agent: escalating them would free their slot with the agent still
 * running; they are escalated when their Run ends and return to queued or leave the state.
 */
function blockedForever(snapshot: SchedulerSnapshot): DependencyEscalation[] {
  const byId = new Map(snapshot.tasks.map((t) => [t.id, t]));
  const graph = DependencyGraph.from(snapshot.edges);
  const escalate: DependencyEscalation[] = [];
  for (const task of snapshot.tasks) {
    if (isTerminal(task.state) || task.state === "needs_human" || task.state === "paused") continue;
    if (holdsSlot(task)) continue;
    const dependsOnId = graph.dependenciesOf(task.id).find((id) => {
      const dep = byId.get(id);
      return dep !== undefined && failed(dep);
    });
    if (dependsOnId) {
      escalate.push({
        taskId: task.id,
        dependsOnId,
        expected: { state: task.state, subState: task.subState },
      });
    }
  }
  return escalate;
}

function memo<K, V>(fn: (key: K) => V): (key: K) => V {
  const cache = new Map<K, V>();
  return (key) => {
    if (!cache.has(key)) cache.set(key, fn(key));
    return cache.get(key) as V;
  };
}

function copyTask(task: SchedulerTask): SchedulerTask {
  return {
    ...task,
    createdAt: new Date(task.createdAt.getTime()),
    readySince: new Date(task.readySince.getTime()),
    ...(task.retry && {
      retry: { ...task.retry, lastFailedAt: new Date(task.retry.lastFailedAt.getTime()) },
    }),
  };
}

/** What the snapshot keeps: the live ones, the terminal ones they depend on and their edges. */
export function liveSnapshot(
  tasks: readonly SchedulerTask[],
  edges: readonly DependencyEdge[],
): SchedulerSnapshot {
  const live = new Set(tasks.filter((t) => !isTerminal(t.state)).map((t) => t.id));
  const kept = edges.filter((e) => live.has(e.taskId));
  const needed = new Set([...live, ...kept.map((e) => e.dependsOnId)]);
  return {
    tasks: tasks.filter((t) => needed.has(t.id)).map(copyTask),
    edges: kept.map((e) => ({ ...e })),
  };
}

/** In-memory reader for tests of the modules that consume the snapshot; returns copies. */
export class InMemorySchedulerStateReader implements SchedulerStateReader {
  readonly #tasks: SchedulerTask[];
  readonly #edges: DependencyEdge[];

  constructor(tasks: readonly SchedulerTask[] = [], edges: readonly DependencyEdge[] = []) {
    // Keeps everything; the filter is applied on each snapshot.
    this.#tasks = tasks.map(copyTask);
    this.#edges = edges.map((e) => ({ ...e }));
  }

  snapshot(): SchedulerSnapshot {
    return liveSnapshot(this.#tasks, this.#edges);
  }
}
