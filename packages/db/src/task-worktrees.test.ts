import { describe, expect, it } from "vitest";
import { TaskWorktreeRepository } from "./task-worktrees.ts";
import { insertProject, insertTask, migratedDatabase } from "./test-helpers.ts";

function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  return { db, project, repo: new TaskWorktreeRepository(db) };
}

describe("TaskWorktreeRepository", () => {
  it("lee estado, PR, branch y worktree de una tarea", () => {
    const { db, project, repo } = setup();
    const task = insertTask(db, project.id, { state: "completed", prState: "open" });
    expect(repo.get(task.id)).toEqual({
      id: task.id,
      projectId: project.id,
      state: "completed",
      prState: "open",
      branch: null,
      worktreePath: null,
    });
    expect(repo.get("no-existe")).toBeNull();
  });

  it("guarda el worktree y al limpiarlo conserva el branch", () => {
    const { db, project, repo } = setup();
    const task = insertTask(db, project.id);
    repo.recordWorktree(task.id, { branch: `lunasq/${task.id}`, worktreePath: "/wt/a" });
    expect(repo.get(task.id)).toMatchObject({ branch: `lunasq/${task.id}`, worktreePath: "/wt/a" });

    repo.clearWorktreePath(task.id);
    repo.clearWorktreePath(task.id);
    expect(repo.get(task.id)).toMatchObject({ branch: `lunasq/${task.id}`, worktreePath: null });
  });

  it("recordWorktree lanza si la tarea no existe", () => {
    const { repo } = setup();
    expect(() => repo.recordWorktree("no-existe", { branch: "b", worktreePath: "/p" })).toThrow(
      /no-existe/,
    );
  });

  it("releasable lista las tareas canceladas o mergeadas que conservan su worktree", () => {
    const { db, project, repo } = setup();
    const withWt = (overrides: Parameters<typeof insertTask>[2]) => {
      const task = insertTask(db, project.id, overrides);
      repo.recordWorktree(task.id, { branch: `lunasq/${task.id}`, worktreePath: `/wt/${task.id}` });
      return task;
    };
    const cancelled = withWt({ state: "cancelled" });
    const merged = withWt({ state: "completed", prState: "merged" });
    withWt({ state: "completed", prState: "open" });
    withWt({ state: "verification", subState: "running", prState: "merged" });
    withWt({ state: "in_progress", subState: "queued" });
    insertTask(db, project.id, { state: "cancelled" });

    expect(
      repo
        .releasable()
        .map((t) => t.id)
        .sort(),
    ).toEqual([cancelled.id, merged.id].sort());
  });
});
