// Branch y worktree de las tareas (UW-09, ADR 0010). Solo toca esas dos columnas: estado,
// sub-estado e iteración cambian únicamente por task-transitions (ADR 0007).
import type { TaskWorktreeRecord, TaskWorktreeStore } from "@lunasq/domain";
import { eq } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { tasks } from "./schema.ts";

const columns = {
  id: tasks.id,
  projectId: tasks.projectId,
  state: tasks.state,
  prState: tasks.prState,
  branch: tasks.branch,
  worktreePath: tasks.worktreePath,
};

export class TaskWorktreeRepository implements TaskWorktreeStore {
  constructor(private readonly db: LunasqDatabase) {}

  get(taskId: string): TaskWorktreeRecord | null {
    return this.db.select(columns).from(tasks).where(eq(tasks.id, taskId)).get() ?? null;
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

  clearWorktreePath(taskId: string): void {
    this.db.update(tasks).set({ worktreePath: null }).where(eq(tasks.id, taskId)).run();
  }
}
