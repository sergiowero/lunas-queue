// Branch and worktree of the tasks (UW-09, ADR 0012). It only touches those two columns: state,
// sub-state and iteration change only through task-transitions (ADR 0007).
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
  resultKind: tasks.resultKind,
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
    if (updated.length === 0) throw new Error(`task ${taskId} does not exist`);
  }

  /**
   * Tasks that no longer use their worktree and keep it: canceled, or completed with the PR merged or with
   * a Result (docs/design.md §Worktree lifecycle). Reconciliation removes them.
   */
  releasable(): TaskWorktreeRecord[] {
    return this.db
      .select(columns)
      .from(tasks)
      .where(
        and(
          isNotNull(tasks.worktreePath),
          // The same rule as worktreeReleased (domain): canceled, or completed and merged or with
          // Resultado.
          or(
            eq(tasks.state, "cancelled"),
            and(
              eq(tasks.state, "completed"),
              or(eq(tasks.prState, "merged"), isNotNull(tasks.resultKind)),
            ),
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
