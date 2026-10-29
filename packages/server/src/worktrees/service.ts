// Ciclo de vida del worktree de una tarea (UW-09; docs/design.md §Ciclo de vida del worktree,
// docs/decisions/0012-ciclo-de-vida-worktrees.md). Una tarea = un worktree = un branch, desde el
// primer despacho hasta el merge. La BD es la verdad: `worktree_path` se guarda solo cuando el
// worktree quedó listo, así un bootstrap que falló se reintenta en el siguiente `ensure`.
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
  /** Id del workspace de herdr por proyecto; sin él, herdr lo encuentra por label. */
  workspaces?: ProjectWorkspaceStore;
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
  private readonly workspaces: ProjectWorkspaceStore | undefined;
  private readonly bootstrapTimeoutMs: number;
  /** Serializa las operaciones de una misma tarea; tareas distintas corren en paralelo. */
  private readonly locks = new KeyedLock();
  /**
   * Serializa por proyecto lo que toca el repo y herdr (workspace, fetch, create, remove): herdr
   * no crea el workspace de forma atómica y git bloquea refs y config. El bootstrap queda fuera.
   * Siempre se toma dentro del lock de la tarea, nunca al revés.
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
      const branch = taskBranch(taskId);

      const { worktree, created } = await this.projectLocks.run(project.id, async () => {
        const workspaceId = await this.projectWorkspace(project);
        const existing = (await this.herdr.listWorktrees(workspaceId)).some(
          (w) => w.branch === branch,
        );
        // Solo al crear: la rama base remota ya trae el merge de las dependencias.
        const base = existing ? project.baseBranch : await this.fetchBase(project);
        return this.herdr.ensureWorktree({
          workspaceId,
          branch,
          base,
          label: `${project.name} ${taskId.slice(0, 8)}`,
        });
      });

      if (created || task.worktreePath !== worktree.path) {
        // Una ruta guardada que ya no corresponde no puede seguir constando como lista.
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
   * Borra el checkout (no el branch) y cierra su workspace. Idempotente. Con cambios sin commit
   * falla con `dirty_worktree` salvo con `force`.
   */
  remove(taskId: string, opts: { force?: boolean } = {}): Promise<{ removed: boolean }> {
    return this.locks.run(taskId, async () => {
      const task = this.tasks.get(taskId);
      if (!task) throw new WorktreeError("task_not_found", `tarea ${taskId} no existe`);
      const project = this.project(task.projectId);
      const removed = await this.removeBranch(project, taskBranch(taskId), opts.force);
      this.tasks.clearWorktreePath(taskId);
      return { removed };
    });
  }

  /**
   * Worktrees de LunasQ del repo del proyecto cuya tarea no existe o ya los liberó. La tarea se
   * busca en todos los proyectos: dos proyectos pueden compartir repo.
   */
  async findOrphans(projectId: string) {
    const project = this.project(projectId);
    const worktrees = await this.projectLocks.run(project.id, async () =>
      this.herdr.listWorktrees(await this.projectWorkspace(project)),
    );
    return findOrphanWorktrees(worktrees, (id) => this.tasks.get(id) ?? undefined);
  }

  /**
   * Remueve los huérfanos sin forzar: uno con cambios sin commit queda en `failed` para que un
   * humano decida. Un fallo no detiene a los demás.
   */
  async cleanupOrphans(projectId: string): Promise<OrphanCleanup> {
    const project = this.project(projectId);
    const result: OrphanCleanup = { removed: [], failed: [] };
    for (const orphan of await this.findOrphans(projectId)) {
      const { taskId, reason, worktree } = orphan;
      try {
        await this.locks.run(taskId, async () => {
          // Revalida bajo el lock: la tarea pudo cambiar desde que se listó.
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
    if (!project) throw new WorktreeError("project_not_found", `proyecto ${projectId} no existe`);
    return project;
  }

  /**
   * Workspace del proyecto: el id guardado si sigue siendo de este proyecto; si no, por label o
   * uno nuevo. herdr reutiliza ids tras reiniciar, así que el guardado solo se acepta si es un
   * workspace principal (no worktree) con el label del proyecto o un pane en su checkout.
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

  /**
   * Remueve el worktree de `branch` según un `worktree list` fresco; false si no había. `worktree
   * remove` necesita el workspace del worktree: si está cerrado lo reabre, y si el remove falla
   * lo vuelve a cerrar.
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
          throw new WorktreeError("dirty_worktree", `${entry.path} tiene cambios sin commit`, {
            cause: err,
          });
        }
        throw err;
      }
      return true;
    });
  }
}
