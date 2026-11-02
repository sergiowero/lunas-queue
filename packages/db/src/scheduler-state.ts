// Reading the state the scheduler needs (ADR 0014): live tasks, the terminal ones they
// depend on and the edges of the live ones, in a single transaction so the snapshot is coherent.
import {
  pendingPhase,
  type RetryState,
  type SchedulerSnapshot,
  type SchedulerStateReader,
  type SchedulerTask,
} from "@lunasq/domain";
import { TASK_TRANSITIONED, type TaskState } from "@lunasq/schemas";
import { and, desc, eq, inArray, isNotNull, isNull, max, notInArray, sql } from "drizzle-orm";
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
  resultKind: tasks.resultKind,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

export class SchedulerStateRepository implements SchedulerStateReader {
  private readonly db: LunasqDatabase | Tx;

  /** Accepts an open transaction: the dispatcher's claim reads the snapshot inside its own. */
  constructor(db: LunasqDatabase | Tx) {
    this.db = db;
  }

  /**
   * readySince = the most recent of the creation, the task's last transition (also a
   * retry: it waits again from there) and the last change of its merged dependencies (the
   * merge of their PR). Editing the priority does not reset the aging.
   *
   * retry = consecutive failed Runs of the pending phase of a task in queued and the end of the
   * last one: the scheduler waits for the backoff before dispatching it again.
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

      // The real provider of each live agent: the one of the open Run (a fallback may not be the primary).
      const openRunKind = new Map(
        (liveIds.length === 0
          ? []
          : tx
              .select({ taskId: runs.taskId, agentKind: runs.agentKind })
              .from(runs)
              .where(and(inArray(runs.taskId, liveIds), isNull(runs.endedAt)))
              .all()
        ).map((row) => [row.taskId, row.agentKind]),
      );

      const rows = [...live, ...terminal];
      // Only already satisfied dependencies (merged PR or completed with a Result): what
      // changes in the others does not make the task ready.
      const mergedAt = new Map(
        rows
          .filter((t) => t.prState === "merged" || (t.state === "completed" && t.resultKind))
          .map((t) => [t.id, t.updatedAt.getTime()]),
      );
      const depsOf = new Map<string, string[]>();
      for (const e of edges) depsOf.set(e.taskId, [...(depsOf.get(e.taskId) ?? []), e.dependsOnId]);

      const toTask = (row: (typeof rows)[number]): SchedulerTask => {
        const retry = row.subState === "queued" ? retryState(tx, row.id, row.state) : undefined;
        const agentKind = openRunKind.get(row.id);
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
          resultKind: row.resultKind,
          createdAt: row.createdAt,
          readySince: new Date(since),
          ...(retry && { retry }),
          ...(agentKind && { agentKind }),
        };
      };
      return { tasks: rows.map(toTask), edges };
    });
  }
}

/** Consecutive failures of the pending phase and when the last one ended; undefined without failures. */
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
