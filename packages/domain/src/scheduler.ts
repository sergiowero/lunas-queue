// Reglas del scheduler (docs/design.md §Scheduler, ADR 0014). TypeScript puro: quien llama lee un
// snapshot de las tareas y del DAG; aquí se calculan el ready set, el score y qué se despacha sin
// exceder ningún límite de concurrencia. Sin preemption: solo se reparten los slots libres.
import type {
  AgentKind,
  Phase,
  PrState,
  SchedulerConfig,
  StatePosition,
  SubState,
  TaskState,
} from "@lunasq/schemas";
import { type DependencyEdge, DependencyGraph } from "./dependency-graph.ts";
import { type ProjectConfigReader, phaseProfile } from "./project-config.ts";
import { isTerminal } from "./state-machine.ts";

/** Lo que el scheduler necesita de una tarea. */
export type SchedulerTask = {
  id: string;
  projectId: string;
  state: TaskState;
  subState: SubState | null;
  /** Prioridad base capturada por el humano; la efectiva se calcula. */
  priority: number;
  prState: PrState | null;
  createdAt: Date;
  /** Desde cuándo la tarea espera en su posición actual: la base del aging. */
  readySince: Date;
};

/**
 * Tareas vivas (no terminales), las terminales de las que alguna viva depende, y las aristas de
 * las vivas.
 */
export type SchedulerSnapshot = { tasks: SchedulerTask[]; edges: DependencyEdge[] };

/** Puerto de lectura: el scheduler toma un snapshot por pasada. */
export interface SchedulerStateReader {
  snapshot(): SchedulerSnapshot;
}

export type DispatchDecision = {
  taskId: string;
  projectId: string;
  phase: Phase;
  agentKind: AgentKind;
  score: number;
  /** Posición leída; el claim la usa para rechazar si la tarea ya se movió. */
  expected: StatePosition;
};

/** Dependiente de una tarea que ya no se entregará (PR cerrado sin merge o cancelada). */
export type DependencyEscalation = {
  taskId: string;
  dependsOnId: string;
  expected: StatePosition;
};

export type SchedulePlan = { dispatch: DispatchDecision[]; escalate: DependencyEscalation[] };

export type RankedTask = { task: SchedulerTask; effectivePriority: number; score: number };

const PHASE_BY_STATE: Partial<Record<TaskState, Phase>> = {
  draft: "refine",
  in_progress: "implement",
  verification: "verify",
};

/** Fase cuyo agente espera una tarea en este estado; null si el estado no lleva agente. */
export function pendingPhase(state: TaskState): Phase | null {
  return PHASE_BY_STATE[state] ?? null;
}

const HOUR_MS = 3_600_000;

/** Agente vivo: running, o waiting_human (la pregunta puede contestarse con el agente vivo). */
function holdsSlot(task: SchedulerTask): boolean {
  return (
    pendingPhase(task.state) !== null &&
    (task.subState === "running" || task.subState === "waiting_human")
  );
}

function satisfies(dep: SchedulerTask | undefined): boolean {
  return dep?.prState === "merged";
}

/** Una dependencia que ya no se entregará: su dependiente quedaría esperando para siempre. */
function failed(dep: SchedulerTask): boolean {
  return dep.prState === "closed" || (dep.state === "cancelled" && dep.prState !== "merged");
}

/**
 * Ready set ordenado por score, de mayor a menor; empates por antigüedad y luego por id.
 * score = prioridad efectiva + aging + boost. La prioridad efectiva hereda la mayor prioridad
 * base de las tareas vivas que la tarea bloquea; el boost cuenta esas tareas.
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

/** Contador de agentes vivos por clave contra su límite (sin límite, siempre cabe). */
class Slots<K> {
  readonly #used = new Map<K, number>();

  add(key: K): void {
    this.#used.set(key, (this.#used.get(key) ?? 0) + 1);
  }

  fits(key: K, limit: number | undefined): boolean {
    return limit === undefined || (this.#used.get(key) ?? 0) < limit;
  }
}

/**
 * Qué despachar y qué escalar en esta pasada. Las decisiones respetan, sumadas a los agentes
 * vivos del snapshot, los límites global, por proyecto, por fase y por tipo de agente.
 */
export function schedule(
  snapshot: SchedulerSnapshot,
  projects: Pick<ProjectConfigReader, "get">,
  config: SchedulerConfig,
  now: Date,
): SchedulePlan {
  const project = memo((id: string) => projects.get(id));
  const kindOf = (task: SchedulerTask, phase: Phase): AgentKind | undefined => {
    const config = project(task.projectId);
    return config ? phaseProfile(config, phase).kind : undefined;
  };

  let global = 0;
  const byProject = new Slots<string>();
  const byPhase = new Slots<Phase>();
  const byKind = new Slots<AgentKind>();
  const occupy = (task: SchedulerTask, phase: Phase, kind: AgentKind | undefined) => {
    global += 1;
    byProject.add(task.projectId);
    byPhase.add(phase);
    if (kind) byKind.add(kind);
  };
  for (const task of snapshot.tasks) {
    const phase = pendingPhase(task.state);
    if (phase && holdsSlot(task)) occupy(task, phase, kindOf(task, phase));
  }

  const dispatch: DispatchDecision[] = [];
  for (const { task, score } of rankReady(snapshot, config, now)) {
    if (global >= config.globalConcurrency) break;
    const phase = pendingPhase(task.state) as Phase;
    const settings = project(task.projectId);
    if (!settings) continue;
    const kind = phaseProfile(settings, phase).kind;
    if (
      !byProject.fits(task.projectId, settings.limits.concurrency) ||
      !byPhase.fits(phase, config.phaseConcurrency[phase]) ||
      !byKind.fits(kind, config.agentKindConcurrency[kind])
    ) {
      continue;
    }
    occupy(task, phase, kind);
    dispatch.push({
      taskId: task.id,
      projectId: task.projectId,
      phase,
      agentKind: kind,
      score,
      expected: { state: task.state, subState: task.subState },
    });
  }
  return { dispatch, escalate: blockedForever(snapshot) };
}

/** Dependientes vivos (salvo needs_human) con una dependencia que ya no se entregará. */
function blockedForever(snapshot: SchedulerSnapshot): DependencyEscalation[] {
  const byId = new Map(snapshot.tasks.map((t) => [t.id, t]));
  const graph = DependencyGraph.from(snapshot.edges);
  const escalate: DependencyEscalation[] = [];
  for (const task of snapshot.tasks) {
    if (isTerminal(task.state) || task.state === "needs_human") continue;
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
  };
}

/** Lo que el snapshot conserva: las vivas, las terminales de las que dependen y sus aristas. */
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

/** Reader en memoria para tests de los módulos que consumen el snapshot; devuelve copias. */
export class InMemorySchedulerStateReader implements SchedulerStateReader {
  readonly #tasks: SchedulerTask[];
  readonly #edges: DependencyEdge[];

  constructor(tasks: readonly SchedulerTask[] = [], edges: readonly DependencyEdge[] = []) {
    // Guarda todo; el filtro se aplica en cada snapshot.
    this.#tasks = tasks.map(copyTask);
    this.#edges = edges.map((e) => ({ ...e }));
  }

  snapshot(): SchedulerSnapshot {
    return liveSnapshot(this.#tasks, this.#edges);
  }
}
