// Branch y worktree de las tareas (UW-09, ADR 0012). Solo toca esas dos columnas: estado,
// sub-estado e iteración cambian únicamente por task-transitions (ADR 0007).
import type { TaskWorktreeRecord, TaskWorktreeStore } from "@lunasq/domain";
import { and, eq, isNotNull, or } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { tasks } from "./schema.ts";
import { requireTaskNumber } from "./tasks.ts";

const columns = {
  id: tasks.id,
  number: tasks.number,
  projectId: tasks.projectId,
  state: tasks.state,
  prState: tasks.prState,
  branch: tasks.branch,
  worktreePath: tasks.worktreePath,
};

function toRecord(row: Omit<TaskWorktreeRecord, "number"> & { number: number | null }) {
  return { ...row, number: requireTaskNumber(row.number) };
}

export class TaskWorktreeRepository implements TaskWorktreeStore {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  get(taskId: string): TaskWorktreeRecord | null {
    const row = this.db.select(columns).from(tasks).where(eq(tasks.id, taskId)).get();
    return row ? toRecord(row) : null;
  }

  recordWorktree(taskId: string, worktree: { branch: string; worktreePath: string }): void {
    const updated = this.db
      .update(tasks)
      .set({ branch: worktree.branch, worktreePath: worktree.worktreePath })
      .where(eq(tasks.id, taskId))
      .returning({ id: tasks.id })
      .all();
    if (updated.length === 0) throw new Error(`tarea ${taskId} no existe`);
  }

  /**
   * Tareas que ya no usan su worktree y lo conservan: canceladas, o completadas con el PR mergeado
   * (docs/design.md §Ciclo de vida del worktree). La reconciliación las remueve.
   */
  releasable(): TaskWorktreeRecord[] {
    return this.db
      .select(columns)
      .from(tasks)
      .where(
        and(
          isNotNull(tasks.worktreePath),
          // La misma regla que worktreeReleased (domain): cancelada, o completada y mergeada.
          or(
            eq(tasks.state, "cancelled"),
            and(eq(tasks.state, "completed"), eq(tasks.prState, "merged")),
          ),
        ),
      )
      .all()
      .map(toRecord);
  }

  clearWorktreePath(taskId: string): void {
    this.db.update(tasks).set({ worktreePath: null }).where(eq(tasks.id, taskId)).run();
  }
}
