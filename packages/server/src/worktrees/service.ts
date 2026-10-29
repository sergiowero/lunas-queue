// Ciclo de vida del worktree de una tarea (UW-09; docs/design.md §Ciclo de vida del worktree,
// docs/decisions/0010-ciclo-de-vida-worktrees.md). Una tarea = un worktree = un branch, desde el
// primer despacho hasta el merge. La BD es la verdad: `worktree_path` se guarda solo cuando el
// worktree quedó listo, así un bootstrap que falló se reintenta en el siguiente `ensure`.
import {
  type HerdrAdapter,
  type HerdrWorktreeEntry,
  isHerdrError,
  type ProcessRunner,
} from "@lunasq/adapters";
import {
  findOrphanWorktrees,
  type OrphanReason,
  type ProjectConfigReader,
  type TaskWorktreeStore,
  taskBranch,
  worktreeReleased,
} from "@lunasq/domain";
import type { Project } from "@lunasq/schemas";
import { KeyedLock } from "./keyed-lock.ts";

export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;
/** Cuánto de la salida de un comando fallido entra en el mensaje del error. */
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
  bootstrapTimeoutMs?: number;
}

export interface EnsuredWorktree {
  branch: string;
  path: string;
  /** Workspace de herdr que abre el worktree; cambia si se cerró y se reabrió. */
  workspaceId: string;
  rootPaneId: string;
  /** true solo la vez que se creó el checkout. */
  created: boolean;
}

export interface OrphanCleanup {
  removed: { taskId: string; path: string; reason: OrphanReason }[];
  failed: { taskId: string; path: string; code: string; message: string }[];
}

/** Comilla simple para `sh -c`. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const tail = (text: string) => text.slice(-OUTPUT_IN_ERROR).trim();

export class WorktreeService {
  private readonly herdr: HerdrAdapter;
  private readonly processes: ProcessRunner;
  private readonly projects: ProjectConfigReader;
  private readonly tasks: TaskWorktreeStore;
  private readonly bootstrapTimeoutMs: number;
  /** Serializa las operaciones de una misma tarea; tareas distintas corren en paralelo. */
  private readonly locks = new KeyedLock();

  constructor(deps: WorktreeServiceDeps) {
    this.herdr = deps.herdr;
    this.processes = deps.processes;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.bootstrapTimeoutMs = deps.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  }

  /**
   * Asegura el checkout de la tarea: lo crea desde la rama base la primera vez y lo reabre
   * después. Idempotente; corre el bootstrap mientras el worktree no conste como listo en la BD.
   */
  ensure(taskId: string): Promise<EnsuredWorktree> {
    return this.locks.run(taskId, async () => {
      const task = this.tasks.get(taskId);
      if (!task) throw new WorktreeError("task_not_found", `tarea ${taskId} no existe`);
      if (worktreeReleased(task)) {
        throw new WorktreeError("task_released", `la tarea ${taskId} ya liberó su worktree`);
      }
      const project = this.project(task.projectId);
      const workspaceId = await this.projectWorkspace(project);
      const branch = taskBranch(taskId);

      const existing = (await this.herdr.listWorktrees(workspaceId)).some(
        (w) => w.branch === branch,
      );
      // Solo al crear: la rama base remota ya trae el merge de las dependencias.
      const base = existing ? project.baseBranch : await this.fetchBase(project);
      const { worktree, created } = await this.herdr.ensureWorktree({
        workspaceId,
        branch,
        base,
        label: `${project.name} ${taskId.slice(0, 8)}`,
      });

      if (created || task.worktreePath !== worktree.path) {
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
   * Borra el checkout (no el branch) y cierra su workspace. Idempotente. Con cambios sin commit
   * falla con `dirty_worktree` salvo con `force`.
   */
  remove(taskId: string, opts: { force?: boolean } = {}): Promise<{ removed: boolean }> {
    return this.locks.run(taskId, async () => {
      const task = this.tasks.get(taskId);
      if (!task) throw new WorktreeError("task_not_found", `tarea ${taskId} no existe`);
      const project = this.project(task.projectId);
      const workspaceId = await this.projectWorkspace(project);
      const branch = taskBranch(taskId);
      const entry = (await this.herdr.listWorktrees(workspaceId)).find((w) => w.branch === branch);
      if (entry) await this.removeEntry(project, workspaceId, entry, opts.force);
      this.tasks.clearWorktreePath(taskId);
      return { removed: entry !== undefined };
    });
  }

  /** Worktrees de LunasQ del proyecto cuya tarea no existe o ya los liberó. */
  async findOrphans(projectId: string) {
    const project = this.project(projectId);
    const workspaceId = await this.projectWorkspace(project);
    const tasks = new Map(this.tasks.listByProject(projectId).map((t) => [t.id, t]));
    const worktrees = await this.herdr.listWorktrees(workspaceId);
    return findOrphanWorktrees(worktrees, (id) => tasks.get(id));
  }

  /**
   * Remueve los huérfanos sin forzar: uno con cambios sin commit queda en `failed` para que un
   * humano decida. Un fallo no detiene a los demás.
   */
  async cleanupOrphans(projectId: string): Promise<OrphanCleanup> {
    const project = this.project(projectId);
    const workspaceId = await this.projectWorkspace(project);
    const result: OrphanCleanup = { removed: [], failed: [] };
    for (const orphan of await this.findOrphans(projectId)) {
      const { taskId, reason, worktree } = orphan;
      try {
        await this.locks.run(taskId, async () => {
          // Revalida bajo el lock: la tarea pudo cambiar desde que se listó.
          const task = this.tasks.get(taskId);
          if (task && !worktreeReleased(task)) return;
          await this.removeEntry(project, workspaceId, worktree, false);
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
    if (!project) throw new WorktreeError("project_not_found", `proyecto ${projectId} no existe`);
    return project;
  }

  private async projectWorkspace(project: Project): Promise<string> {
    // El id del workspace se guardará en Project con UW-16; mientras, herdr lo encuentra por label.
    const { workspace } = await this.herdr.ensureWorkspace({
      cwd: project.localPath,
      label: project.name,
    });
    return workspace.workspaceId;
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
        `git fetch origin ${project.baseBranch} falló (exit ${res.exitCode}): ${tail(res.stderr)}`,
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
        `bootstrap de ${taskId} falló (${why}): ${tail(res.stderr) || tail(res.stdout)}`,
      );
    }
  }

  /** `worktree remove` necesita el workspace del worktree: si está cerrado, lo reabre antes. */
  private async removeEntry(
    project: Project,
    projectWorkspaceId: string,
    entry: HerdrWorktreeEntry,
    force: boolean | undefined,
  ) {
    let workspaceId = entry.workspaceId;
    if (workspaceId === undefined && entry.branch !== undefined) {
      const { worktree } = await this.herdr.ensureWorktree({
        workspaceId: projectWorkspaceId,
        branch: entry.branch,
        base: project.baseBranch,
      });
      workspaceId = worktree.workspaceId;
    }
    if (workspaceId === undefined) return;
    try {
      await this.herdr.removeWorktree({ workspaceId, ...(force && { force }) });
    } catch (err) {
      if (isHerdrError(err, "dirty_worktree_requires_force")) {
        throw new WorktreeError("dirty_worktree", `${entry.path} tiene cambios sin commit`, {
          cause: err,
        });
      }
      throw err;
    }
  }
}
