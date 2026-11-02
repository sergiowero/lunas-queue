import { describe, expect, it } from "vitest";
import { TaskWorktreeRepository } from "./task-worktrees.ts";
import { insertProject, insertTask, migratedDatabase } from "./test-helpers.ts";

function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  return { db, project, repo: new TaskWorktreeRepository(db) };
}

describe("TaskWorktreeRepository", () => {
  it("reads state, PR, branch and worktree of a task", () => {
    const { db, project, repo } = setup();
    const task = insertTask(db, project.id, { state: "completed", prState: "open" });
    expect(repo.get(task.id)).toEqual({
      id: task.id,
      number: task.number,
      projectId: project.id,
      state: "completed",
      prState: "open",
      resultKind: null,
      branch: null,
      worktreePath: null,
    });
    expect(repo.get("no-existe")).toBeNull();
  });

  it("stores the worktree and keeps the branch when clearing it", () => {
    const { db, project, repo } = setup();
    const task = insertTask(db, project.id);
    repo.recordWorktree(task.id, { branch: `lunasq/${task.id}`, worktreePath: "/wt/a" });
    expect(repo.get(task.id)).toMatchObject({ branch: `lunasq/${task.id}`, worktreePath: "/wt/a" });

    repo.clearWorktreePath(task.id);
    repo.clearWorktreePath(task.id);
    expect(repo.get(task.id)).toMatchObject({ branch: `lunasq/${task.id}`, worktreePath: null });
  });

  it("recordWorktree throws if the task does not exist", () => {
    const { repo } = setup();
    expect(() => repo.recordWorktree("no-existe", { branch: "b", worktreePath: "/p" })).toThrow(
      /no-existe/,
    );
  });

  it("releasable lists the canceled, merged or with-Result tasks that keep their worktree", () => {
    const { db, project, repo } = setup();
    const withWt = (overrides: Parameters<typeof insertTask>[2]) => {
      const task = insertTask(db, project.id, overrides);
      repo.recordWorktree(task.id, { branch: `lunasq/${task.id}`, worktreePath: `/wt/${task.id}` });
      return task;
    };
    const cancelled = withWt({ state: "cancelled" });
    const merged = withWt({ state: "completed", prState: "merged" });
    const withResult = withWt({ state: "completed", subState: null, resultKind: "research" });
    withWt({ state: "completed", prState: "open" });
    withWt({ state: "verification", subState: "running", prState: "merged" });
    withWt({ state: "in_progress", subState: "queued" });
    insertTask(db, project.id, { state: "cancelled" });

    expect(
      repo
        .releasable()
        .map((t) => t.id)
        .sort(),
    ).toEqual([cancelled.id, merged.id, withResult.id].sort());
  });
});
