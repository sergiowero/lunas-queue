// Rules of the lifecycle of a task's worktree (docs/design.md §Worktree lifecycle,
// docs/decisions/0012-ciclo-de-vida-worktrees.md): branch name and when a worktree is no longer needed.
import type { PrState, ResultKind, TaskState } from "@lunasq/schemas";

export const TASK_BRANCH_PREFIX = "lunasq/";

/** A single ref segment safe for git (the task UUIDs meet it). */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Task branch: deterministic, one per task, never shared. */
export function taskBranch(taskId: string): string {
  if (!SAFE_SEGMENT.test(taskId)) {
    throw new Error(`invalid task id for a branch: ${JSON.stringify(taskId)}`);
  }
  return `${TASK_BRANCH_PREFIX}${taskId}`;
}

/** The task id if `branch` is a LunasQ branch; otherwise undefined. */
export function taskIdFromBranch(branch: string): string | undefined {
  if (!branch.startsWith(TASK_BRANCH_PREFIX)) return undefined;
  const id = branch.slice(TASK_BRANCH_PREFIX.length);
  return SAFE_SEGMENT.test(id) ? id : undefined;
}

export type WorktreeTaskView = {
  state: TaskState;
  prState: PrState | null;
  /** Task completed with a Result (submit_result): it has no PR to wait for. */
  resultKind?: ResultKind | null;
};

/**
 * The task no longer needs its worktree: it was cancelled, its PR was merged or it was completed with a Result.
 * completed arrives with the PR open and the task can return to in progress, so it is not enough.
 */
export function worktreeReleased(task: WorktreeTaskView): boolean {
  if (task.state === "cancelled") return true;
  return task.state === "completed" && (task.prState === "merged" || Boolean(task.resultKind));
}

/**
 * Removing the worktree may discard uncommitted changes (the branch is always kept). Only a cancelled
 * task accepts that; merged or Result-completed tasks and orphans of unknown tasks never force.
 */
export function worktreeForceRemovable(task: WorktreeTaskView): boolean {
  return task.state === "cancelled";
}

export type OrphanReason = "task_not_found" | "task_released";

export type OrphanWorktree<W> = { worktree: W; taskId: string; reason: OrphanReason };

/**
 * Worktrees of LunasQ whose task does not exist or has already released them. Those of foreign branches (or at HEAD
 * detached) are never touched.
 */
export function findOrphanWorktrees<W extends { branch?: string }>(
  worktrees: readonly W[],
  lookup: (taskId: string) => WorktreeTaskView | undefined,
): OrphanWorktree<W>[] {
  const orphans: OrphanWorktree<W>[] = [];
  for (const worktree of worktrees) {
    const taskId = worktree.branch === undefined ? undefined : taskIdFromBranch(worktree.branch);
    if (taskId === undefined) continue;
    const task = lookup(taskId);
    if (!task) orphans.push({ worktree, taskId, reason: "task_not_found" });
    else if (worktreeReleased(task)) orphans.push({ worktree, taskId, reason: "task_released" });
  }
  return orphans;
}

export type TaskWorktreeRecord = WorktreeTaskView & {
  id: string;
  /** Task number (#N): identifies the task in the herdr labels. */
  number: number;
  projectId: string;
  branch: string | null;
  /** Saved only when the worktree is ready (bootstrap included) and deleted when it is removed. */
  worktreePath: string | null;
};

/** Read and write port of the task branch and worktree: db implements it. */
export interface TaskWorktreeStore {
  get(taskId: string): TaskWorktreeRecord | null;
  /** Throws if the task does not exist. */
  recordWorktree(taskId: string, worktree: { branch: string; worktreePath: string }): void;
  /** Keeps the branch: `worktree remove` does not delete it. */
  clearWorktreePath(taskId: string): void;
}

/**
 * Id of the herdr workspace of each project (docs/design.md §Dispatch sequence, step 2). It is
 * a hint: herdr is ephemeral and `ensureWorkspace` revalidates it; db implements it.
 */
export interface ProjectWorkspaceStore {
  get(projectId: string): string | null;
  record(projectId: string, workspaceId: string): void;
}
