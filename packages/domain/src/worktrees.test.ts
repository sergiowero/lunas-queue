import { describe, expect, it } from "vitest";
import {
  findOrphanWorktrees,
  taskBranch,
  taskIdFromBranch,
  worktreeReleased,
} from "./worktrees.ts";

const ID_A = "0b6f3c1e-8a4d-4f7e-9c2a-1d5e6f7a8b9c";
const ID_B = "5d2e1f0a-3b4c-4d5e-8f6a-7b8c9d0e1f2a";

describe("taskBranch", () => {
  it("is deterministic and reversible", () => {
    expect(taskBranch(ID_A)).toBe(`lunasq/${ID_A}`);
    expect(taskBranch(ID_A)).toBe(taskBranch(ID_A));
    expect(taskIdFromBranch(taskBranch(ID_A))).toBe(ID_A);
  });

  it("two tasks never share a branch", () => {
    expect(taskBranch(ID_A)).not.toBe(taskBranch(ID_B));
  });

  it("rejects ids that do not work as a ref name", () => {
    for (const bad of ["", "a b", "a..b", "a/b", "-x", "a~1", "x.lock"]) {
      expect(() => taskBranch(bad), bad).toThrow();
    }
  });

  it("taskIdFromBranch ignores branches that are not LunasQ's", () => {
    expect(taskIdFromBranch("main")).toBeUndefined();
    expect(taskIdFromBranch("feature/lunasq")).toBeUndefined();
    expect(taskIdFromBranch("lunasq/")).toBeUndefined();
    expect(taskIdFromBranch("lunasq/a/b")).toBeUndefined();
  });
});

describe("worktreeReleased", () => {
  it("releases the worktree on cancel or after the merge, not before", () => {
    expect(worktreeReleased({ state: "cancelled", prState: null })).toBe(true);
    expect(worktreeReleased({ state: "completed", prState: "merged" })).toBe(true);
    // completed arrives with the PR open: the worktree is kept until the merge.
    expect(worktreeReleased({ state: "completed", prState: "open" })).toBe(false);
    expect(worktreeReleased({ state: "completed", prState: "closed" })).toBe(false);
    expect(worktreeReleased({ state: "completed", prState: null })).toBe(false);
    // completed with a Result has no PR and does not return to in progress: nothing to keep.
    expect(worktreeReleased({ state: "completed", prState: null, resultKind: "research" })).toBe(
      true,
    );
    expect(worktreeReleased({ state: "in_progress", prState: null, resultKind: "research" })).toBe(
      false,
    );
    for (const state of [
      "draft",
      "refined",
      "in_progress",
      "verification",
      "needs_human",
    ] as const) {
      expect(worktreeReleased({ state, prState: null }), state).toBe(false);
    }
  });
});

describe("findOrphanWorktrees", () => {
  const tasks = new Map([
    [ID_A, { state: "in_progress" as const, prState: null }],
    [ID_B, { state: "cancelled" as const, prState: null }],
  ]);
  const lookup = (id: string) => tasks.get(id);

  it("marks as orphans the worktrees of released or nonexistent tasks", () => {
    const gone = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
    const worktrees = [
      { branch: taskBranch(ID_A), path: "/wt/a" },
      { branch: taskBranch(ID_B), path: "/wt/b" },
      { branch: taskBranch(gone), path: "/wt/gone" },
    ];
    expect(findOrphanWorktrees(worktrees, lookup)).toEqual([
      { worktree: worktrees[1], taskId: ID_B, reason: "task_released" },
      { worktree: worktrees[2], taskId: gone, reason: "task_not_found" },
    ]);
  });

  it("does not touch the worktrees that LunasQ did not create", () => {
    const worktrees = [{ branch: "feature/x", path: "/wt/x" }, { path: "/wt/detached" }];
    expect(findOrphanWorktrees(worktrees, lookup)).toEqual([]);
  });
});
