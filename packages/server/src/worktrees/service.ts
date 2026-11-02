// Lifecycle of a task's worktree (docs/design.md §Worktree lifecycle,
// docs/decisions/0012-ciclo-de-vida-worktrees.md). One task = one worktree = one branch, from the
// first dispatch until the merge. The DB is the truth: `worktree_path` is saved only when the
// worktree is ready, so a bootstrap that failed is retried on the next `ensure`.
import { type HerdrAdapter, isHerdrError, type ProcessRunner } from "@lunasq/adapters";
import {
  findOrphanWorktrees,
  type OrphanReason,
  type ProjectConfigReader,
  type ProjectWorkspaceStore,
  type TaskWorktreeStore,
  taskBranch,
  worktreeReleased,
} from "@lunasq/domain";
import { type Project, taskLabel } from "@lunasq/schemas";
import { KeyedLock } from "./keyed-lock.ts";

export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;
/** How much of a failed command's output goes into the error message. */
const OUTPUT_IN_ERROR = 2_000;

export type WorktreeErrorCode =
  | "task_not_found"
  | "project_not_found"
  | "task_released"
  | "base_fetch_failed"
  | "bootstrap_failed"
  | "dirty_worktree";

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;

  constructor(code: WorktreeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorktreeError";
    this.code = code;
  }
}

export function isWorktreeError(err: unknown, code?: WorktreeErrorCode): err is WorktreeError {
  return err instanceof WorktreeError && (code === undefined || err.code === code);
}

export interface WorktreeServiceDeps {
  herdr: HerdrAdapter;
  processes: ProcessRunner;
  projects: ProjectConfigReader;
  tasks: TaskWorktreeStore;
  /** herdr workspace id per project; without it, herdr finds it by label. */
  workspaces?: ProjectWorkspaceStore;
  bootstrapTimeoutMs?: number;
}

export interface EnsuredWorktree {
  branch: string;
  path: string;
  /** herdr workspace that opens the worktree; changes if it was closed and reopened. */
  workspaceId: string;
  rootPaneId: string;
  /** true only the time the checkout was created. */
  created: boolean;
}

export interface OrphanCleanup {
  removed: { taskId: string; path: string; reason: OrphanReason }[];
  failed: { taskId: string; path: string; code: string; message: string }[];
}

/** Single quote for `sh -c`. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const tail = (text: string) => text.slice(-OUTPUT_IN_ERROR).trim();

export class WorktreeService {
  private readonly herdr: HerdrAdapter;
  private readonly processes: ProcessRunner;
  private readonly projects: ProjectConfigReader;
  private readonly tasks: TaskWorktreeStore;
  private readonly workspaces: ProjectWorkspaceStore | undefined;
  private readonly bootstrapTimeoutMs: number;
  /** Serializes the operations of the same task; different tasks run in parallel. */
  private readonly locks = new KeyedLock();
  /**
   * Serializes per project what touches the repo and herdr (workspace, fetch, create, remove): herdr
   * does not create the workspace atomically and git locks refs and config. The bootstrap stays outside.
   * It is always taken inside the task's lock, never the other way around.
   */
  private readonly projectLocks = new KeyedLock();

  constructor(deps: WorktreeServiceDeps) {
    this.herdr = deps.herdr;
    this.processes = deps.processes;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.workspaces = deps.workspaces;
    this.bootstrapTimeoutMs = deps.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  }

  /**
   * Ensures the task's checkout: creates it from the base branch the first time and reopens it
   * afterwards. Idempotent; runs the bootstrap while the worktree is not recorded as ready in the DB.
   */
  ensure(taskId: string): Promise<EnsuredWorktree> {
    return this.locks.run(taskId, async () => {
      const task = this.tasks.get(taskId);
      if (!task) throw new WorktreeError("task_not_found", `task ${taskId} does not exist`);
      if (worktreeReleased(task)) {
        throw new WorktreeError("task_released", `task ${taskId} already released its worktree`);
      }
      const project = this.project(task.projectId);
      const branch = taskBranch(taskId);

      const { worktree, created } = await this.projectLocks.run(project.id, async () => {
        const workspaceId = await this.projectWorkspace(project);
        const existing = (await this.herdr.listWorktrees(workspaceId)).some(
          (w) => w.branch === branch,
        );
        // Only on creation: the remote base branch already carries the dependencies' merge.
        const base = existing ? project.baseBranch : await this.fetchBase(project);
        return this.herdr.ensureWorktree({
          workspaceId,
          branch,
          base,
          label: `${project.name} ${taskLabel(task.number)}`,
        });
      });

      if (created || task.worktreePath !== worktree.path) {
        // A stored path that no longer matches cannot keep being recorded as ready.
        if (task.worktreePath !== null) this.tasks.clearWorktreePath(taskId);
        await this.bootstrap(project, taskId, branch, worktree.path);
      }
      this.tasks.recordWorktree(taskId, { branch, worktreePath: worktree.path });
      return {
        branch,
        path: worktree.path,
        workspaceId: worktree.workspaceId,
        rootPaneId: worktree.rootPaneId,
        created,
      };
    });
  }

  /**
   * Deletes the checkout (not the branch) and closes its workspace. Idempotent. With uncommitted
   * changes it fails with `dirty_worktree` unless `force`.
   */
  remove(taskId: string, opts: { force?: boolean } = {}): Promise<{ removed: boolean }> {
    return this.locks.run(taskId, async () => {
      const task = this.tasks.get(taskId);
      if (!task) throw new WorktreeError("task_not_found", `task ${taskId} does not exist`);
      const project = this.project(task.projectId);
      const removed = await this.removeBranch(project, taskBranch(taskId), opts.force);
      this.tasks.clearWorktreePath(taskId);
      return { removed };
    });
  }

  /**
   * LunasQ worktrees of the project's repo whose task does not exist or already released them. The task is
   * looked up in all projects: two projects can share a repo.
   */
  async findOrphans(projectId: string) {
    const project = this.project(projectId);
    const worktrees = await this.projectLocks.run(project.id, async () =>
      this.herdr.listWorktrees(await this.projectWorkspace(project)),
    );
    return findOrphanWorktrees(worktrees, (id) => this.tasks.get(id) ?? undefined);
  }

  /**
   * Removes the orphans without forcing: one with uncommitted changes is left in `failed` for a
   * human to decide. A failure does not stop the others.
   */
  async cleanupOrphans(projectId: string): Promise<OrphanCleanup> {
    const project = this.project(projectId);
    const result: OrphanCleanup = { removed: [], failed: [] };
    for (const orphan of await this.findOrphans(projectId)) {
      const { taskId, reason, worktree } = orphan;
      try {
        await this.locks.run(taskId, async () => {
          // Revalidated under the lock: the task may have changed since it was listed.
          const task = this.tasks.get(taskId);
          if (task && !worktreeReleased(task)) return;
          if (!(await this.removeBranch(project, taskBranch(taskId), false))) return;
          if (task) this.tasks.clearWorktreePath(taskId);
          result.removed.push({ taskId, path: worktree.path, reason });
        });
      } catch (err) {
        const code = isWorktreeError(err) || isHerdrError(err) ? err.code : "internal";
        const message = err instanceof Error ? err.message : String(err);
        result.failed.push({ taskId, path: worktree.path, code, message });
      }
    }
    return result;
  }

  private project(projectId: string): Project {
    const project = this.projects.get(projectId);
    if (!project)
      throw new WorktreeError("project_not_found", `project ${projectId} does not exist`);
    return project;
  }

  /**
   * The project's workspace: the stored id if it is still this project's; otherwise by label or
   * a new one. herdr reuses ids after restarting, so the stored one is only accepted if it is a
   * main workspace (not a worktree) with the project's label or a pane in its checkout.
   */
  private async projectWorkspace(project: Project): Promise<string> {
    const stored = await this.storedWorkspace(project);
    const { workspace } = await this.herdr.ensureWorkspace({
      cwd: project.localPath,
      label: project.name,
      ...(stored !== undefined && { workspaceId: stored }),
    });
    if (workspace.workspaceId !== stored)
      this.workspaces?.record(project.id, workspace.workspaceId);
    return workspace.workspaceId;
  }

  private async storedWorkspace(project: Project): Promise<string | undefined> {
    const id = this.workspaces?.get(project.id);
    if (!id) return undefined;
    const snap = await this.herdr.snapshot();
    const workspace = snap.workspaces.find((w) => w.workspaceId === id);
    if (!workspace || workspace.linkedWorktree) return undefined;
    const inCheckout = snap.panes.some((p) => p.workspaceId === id && p.cwd === project.localPath);
    return workspace.label === project.name || inCheckout ? id : undefined;
  }

  private async fetchBase(project: Project): Promise<string> {
    const res = await this.processes.run({
      command: `git fetch --quiet origin ${shellQuote(project.baseBranch)}`,
      cwd: project.localPath,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (res.exitCode !== 0 || res.timedOut) {
      throw new WorktreeError(
        "base_fetch_failed",
        `git fetch origin ${project.baseBranch} failed (exit ${res.exitCode}): ${tail(res.stderr)}`,
      );
    }
    return `origin/${project.baseBranch}`;
  }

  private async bootstrap(project: Project, taskId: string, branch: string, path: string) {
    if (!project.bootstrap) return;
    const res = await this.processes.run({
      command: project.bootstrap,
      cwd: path,
      env: {
        LUNASQ_PROJECT_ID: project.id,
        LUNASQ_TASK_ID: taskId,
        LUNASQ_BRANCH: branch,
        LUNASQ_BASE_BRANCH: project.baseBranch,
        LUNASQ_WORKTREE: path,
      },
      timeoutMs: this.bootstrapTimeoutMs,
    });
    if (res.exitCode !== 0 || res.timedOut) {
      const why = res.timedOut
        ? `timeout de ${this.bootstrapTimeoutMs} ms`
        : `exit ${res.exitCode}`;
      throw new WorktreeError(
        "bootstrap_failed",
        `bootstrap of ${taskId} failed (${why}): ${tail(res.stderr) || tail(res.stdout)}`,
      );
    }
  }

  /**
   * Removes the worktree of `branch` according to a fresh `worktree list`; false if there was none. `worktree
   * remove` needs the worktree's workspace: if it is closed it reopens it, and if the remove fails
   * it closes it again.
   */
  private removeBranch(project: Project, branch: string, force: boolean | undefined) {
    return this.projectLocks.run(project.id, async () => {
      const projectWorkspaceId = await this.projectWorkspace(project);
      const entry = (await this.herdr.listWorktrees(projectWorkspaceId)).find(
        (w) => w.branch === branch,
      );
      if (!entry) return false;
      let workspaceId = entry.workspaceId;
      const reopened = workspaceId === undefined;
      if (workspaceId === undefined) {
        const opened = await this.herdr.ensureWorktree({
          workspaceId: projectWorkspaceId,
          branch,
          base: project.baseBranch,
        });
        workspaceId = opened.worktree.workspaceId;
      }
      try {
        await this.herdr.removeWorktree({ workspaceId, ...(force && { force }) });
      } catch (err) {
        if (reopened) await this.herdr.closeWorkspace(workspaceId);
        if (isHerdrError(err, "dirty_worktree_requires_force")) {
          throw new WorktreeError("dirty_worktree", `${entry.path} has uncommitted changes`, {
            cause: err,
          });
        }
        throw err;
      }
      return true;
    });
  }
}
