// Lectura del estado que necesita el scheduler (ADR 0014): tareas vivas, las terminales de las que
// dependen y las aristas de las vivas, en una sola transacción para que el snapshot sea coherente.
import {
  pendingPhase,
  type RetryState,
  type SchedulerSnapshot,
  type SchedulerStateReader,
  type SchedulerTask,
} from "@lunasq/domain";
import { TASK_TRANSITIONED, type TaskState } from "@lunasq/schemas";
import { and, desc, eq, inArray, isNotNull, max, notInArray, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { consecutiveFailures } from "./runs.ts";
import { events, runs, taskDependencies, tasks } from "./schema.ts";
import type { Tx } from "./task-transitions.ts";

const TERMINAL: TaskState[] = ["completed", "cancelled"];

const columns = {
  id: tasks.id,
  projectId: tasks.projectId,
  state: tasks.state,
  subState: tasks.subState,
  priority: tasks.priority,
  prState: tasks.prState,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

export class SchedulerStateRepository implements SchedulerStateReader {
  private readonly db: LunasqDatabase | Tx;

  /** Acepta una transacción abierta: el claim del dispatcher lee el snapshot dentro de la suya. */
  constructor(db: LunasqDatabase | Tx) {
    this.db = db;
  }

  /**
   * readySince = lo más reciente entre la creación, la última transición de la tarea (también un
   * reintento: vuelve a esperar desde ahí) y el último cambio de sus dependencias mergeadas (el
   * merge de su PR). Editar la prioridad no reinicia el aging.
   *
   * retry = Runs fallidos seguidos de la fase pendiente de una tarea en queued y el fin del
   * último: el scheduler espera el backoff antes de volver a despacharla.
   */
  snapshot(): SchedulerSnapshot {
    return this.db.transaction((tx) => {
      const live = tx.select(columns).from(tasks).where(notInArray(tasks.state, TERMINAL)).all();
      const liveIds = live.map((t) => t.id);
      const edges =
        liveIds.length === 0
          ? []
          : tx
              .select({
                taskId: taskDependencies.taskId,
                dependsOnId: taskDependencies.dependsOnId,
              })
              .from(taskDependencies)
              .where(inArray(taskDependencies.taskId, liveIds))
              .all();
      const liveSet = new Set(liveIds);
      const missing = [...new Set(edges.map((e) => e.dependsOnId))].filter(
        (id) => !liveSet.has(id),
      );
      const terminal =
        missing.length === 0
          ? []
          : tx.select(columns).from(tasks).where(inArray(tasks.id, missing)).all();
      const lastTransition = new Map(
        (liveIds.length === 0
          ? []
          : tx
              .select({ taskId: events.taskId, at: max(events.createdAt) })
              .from(events)
              .where(and(eq(events.type, TASK_TRANSITIONED), inArray(events.taskId, liveIds)))
              .groupBy(events.taskId)
              .all()
        ).map((row) => [row.taskId, row.at]),
      );

      const rows = [...live, ...terminal];
      // Solo las dependencias ya mergeadas: lo que cambie en las demás no hace lista a la tarea.
      const mergedAt = new Map(
        rows.filter((t) => t.prState === "merged").map((t) => [t.id, t.updatedAt.getTime()]),
      );
      const depsOf = new Map<string, string[]>();
      for (const e of edges) depsOf.set(e.taskId, [...(depsOf.get(e.taskId) ?? []), e.dependsOnId]);

      const toTask = (row: (typeof rows)[number]): SchedulerTask => {
        const retry = row.subState === "queued" ? retryState(tx, row.id, row.state) : undefined;
        const since = Math.max(
          row.createdAt.getTime(),
          lastTransition.get(row.id)?.getTime() ?? 0,
          ...(depsOf.get(row.id) ?? []).map((id) => mergedAt.get(id) ?? 0),
        );
        return {
          id: row.id,
          projectId: row.projectId,
          state: row.state,
          subState: row.subState,
          priority: row.priority,
          prState: row.prState,
          createdAt: row.createdAt,
          readySince: new Date(since),
          ...(retry && { retry }),
        };
      };
      return { tasks: rows.map(toTask), edges };
    });
  }
}

/** Fallos seguidos de la fase pendiente y cuándo terminó el último; undefined sin fallos. */
function retryState(tx: Tx, taskId: string, state: TaskState): RetryState | undefined {
  const phase = pendingPhase(state);
  if (!phase) return undefined;
  const failures = consecutiveFailures(tx, taskId, phase);
  if (failures === 0) return undefined;
  const last = tx
    .select({ endedAt: runs.endedAt })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.phase, phase), isNotNull(runs.endedAt)))
    .orderBy(desc(runs.startedAt), sql`rowid desc`)
    .limit(1)
    .get();
  return last?.endedAt ? { failures, lastFailedAt: last.endedAt } : undefined;
}
