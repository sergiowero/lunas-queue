// Reglas del scheduler (docs/design.md §Scheduler, ADR 0014). TypeScript puro: quien llama lee un
// snapshot de las tareas y del DAG; aquí se calculan el ready set, el score y qué se despacha sin
// exceder ningún límite de concurrencia. Sin preemption: solo se reparten los slots libres.
import type {
  AgentKind,
  Project,
  PrState,
  SchedulablePhase,
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
  /** Runs fallidos seguidos de su fase pendiente y cuándo terminó el último: base del backoff. */
  retry?: RetryState;
};

export type RetryState = { failures: number; lastFailedAt: Date };

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
  phase: SchedulablePhase;
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

const PHASE_BY_STATE: Partial<Record<TaskState, SchedulablePhase>> = {
  draft: "refine",
  in_progress: "implement",
  verification: "verify",
};

/** Fase cuyo agente espera una tarea en este estado; null si el estado no lleva agente. */
export function pendingPhase(state: TaskState): SchedulablePhase | null {
  return PHASE_BY_STATE[state] ?? null;
}

const HOUR_MS = 3_600_000;

/**
 * Cuándo puede volver a despacharse una tarea tras `failures` Runs fallidos seguidos:
 * `retryBackoffMs·2^(failures-1)` desde el último fallo, con tope en `maxRetryBackoffMs`.
 * null si no hay fallos que esperar.
 */
export function retryAt(retry: RetryState | undefined, config: SchedulerConfig): Date | null {
  if (!retry || retry.failures < 1) return null;
  // El exponente se acota antes de calcular: 2^40 ya excede cualquier tope razonable.
  const wait = Math.min(
    config.retryBackoffMs * 2 ** Math.min(retry.failures - 1, 40),
    config.maxRetryBackoffMs,
  );
  return new Date(retry.lastFailedAt.getTime() + wait);
}

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

/** Un agente vivo o por despachar; `agentKind` falta si el proyecto no tiene configuración. */
export type Slot = { projectId: string; phase: SchedulablePhase; agentKind: AgentKind | undefined };

/**
 * Agentes vivos por nivel de límite. `schedule` la usa para planear y el claim del dispatcher
 * (UW-16) para volver a validar con un snapshot fresco, con las mismas reglas.
 */
export class Occupancy {
  #global = 0;
  readonly #byProject = new Slots<string>();
  readonly #byPhase = new Slots<SchedulablePhase>();
  readonly #byKind = new Slots<AgentKind>();
  readonly #projects: (id: string) => Project | null;

  private constructor(projects: Pick<ProjectConfigReader, "get">) {
    this.#projects = memo((id: string) => projects.get(id));
  }

  /** Ocupación de los agentes vivos del snapshot. */
  static of(snapshot: SchedulerSnapshot, projects: Pick<ProjectConfigReader, "get">): Occupancy {
    const occupancy = new Occupancy(projects);
    for (const task of snapshot.tasks) {
      const phase = pendingPhase(task.state);
      if (phase && holdsSlot(task)) occupancy.add(occupancy.slotFor(task, phase));
    }
    return occupancy;
  }

  /** El slot que ocuparía `task` en `phase`, con el tipo de agente del perfil del proyecto. */
  slotFor(task: Pick<SchedulerTask, "projectId">, phase: SchedulablePhase): Slot {
    const settings = this.#projects(task.projectId);
    return {
      projectId: task.projectId,
      phase,
      agentKind: settings ? phaseProfile(settings, phase).kind : undefined,
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

  /** Si un agente más en `slot` cabe en los cuatro niveles; sin configuración de proyecto, no. */
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
 * Qué despachar y qué escalar en esta pasada. Las decisiones respetan, sumadas a los agentes
 * vivos del snapshot, los límites global, por proyecto, por fase y por tipo de agente.
 */
export function schedule(
  snapshot: SchedulerSnapshot,
  projects: Pick<ProjectConfigReader, "get">,
  config: SchedulerConfig,
  now: Date,
): SchedulePlan {
  const occupancy = Occupancy.of(snapshot, projects);
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
 * Dependientes vivos con una dependencia que ya no se entregará. Se omiten los que están en
 * needs_human y los que tienen un agente vivo: escalarlos liberaría su slot con el agente todavía
 * corriendo; se escalan cuando su Run termina y vuelven a queued o salen del estado.
 */
function blockedForever(snapshot: SchedulerSnapshot): DependencyEscalation[] {
  const byId = new Map(snapshot.tasks.map((t) => [t.id, t]));
  const graph = DependencyGraph.from(snapshot.edges);
  const escalate: DependencyEscalation[] = [];
  for (const task of snapshot.tasks) {
    if (isTerminal(task.state) || task.state === "needs_human" || holdsSlot(task)) continue;
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
