// Reglas del ciclo de vida del worktree de una tarea (docs/design.md §Ciclo de vida del worktree,
// docs/decisions/0012-ciclo-de-vida-worktrees.md): nombre del branch y cuándo sobra un worktree.
import type { PrState, TaskState } from "@lunasq/schemas";

export const TASK_BRANCH_PREFIX = "lunasq/";

/** Un solo segmento de ref seguro para git (los UUID de las tareas lo cumplen). */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Branch de la tarea: determinístico, uno por tarea, nunca compartido. */
export function taskBranch(taskId: string): string {
  if (!SAFE_SEGMENT.test(taskId)) {
    throw new Error(`id de tarea inválido para un branch: ${JSON.stringify(taskId)}`);
  }
  return `${TASK_BRANCH_PREFIX}${taskId}`;
}

/** El id de la tarea si `branch` es un branch de LunasQ; si no, undefined. */
export function taskIdFromBranch(branch: string): string | undefined {
  if (!branch.startsWith(TASK_BRANCH_PREFIX)) return undefined;
  const id = branch.slice(TASK_BRANCH_PREFIX.length);
  return SAFE_SEGMENT.test(id) ? id : undefined;
}

export type WorktreeTaskView = { state: TaskState; prState: PrState | null };

/**
 * La tarea ya no necesita su worktree: se canceló o su PR se mergeó. completed llega con el PR
 * abierto y la tarea puede volver a in progress, así que no basta.
 */
export function worktreeReleased(task: WorktreeTaskView): boolean {
  return task.state === "cancelled" || (task.state === "completed" && task.prState === "merged");
}

export type OrphanReason = "task_not_found" | "task_released";

export type OrphanWorktree<W> = { worktree: W; taskId: string; reason: OrphanReason };

/**
 * Worktrees de LunasQ cuya tarea no existe o ya los liberó. Los de branches ajenos (o en HEAD
 * detached) no se tocan nunca.
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
  projectId: string;
  branch: string | null;
  /** Se guarda solo cuando el worktree quedó listo (bootstrap incluido) y se borra al removerlo. */
  worktreePath: string | null;
};

/** Puerto de lectura y escritura del branch y el worktree de las tareas; db lo implementa. */
export interface TaskWorktreeStore {
  get(taskId: string): TaskWorktreeRecord | null;
  /** Lanza si la tarea no existe. */
  recordWorktree(taskId: string, worktree: { branch: string; worktreePath: string }): void;
  /** Conserva el branch: `worktree remove` no lo borra. */
  clearWorktreePath(taskId: string): void;
}

/**
 * Id del workspace de herdr de cada proyecto (docs/design.md §Secuencia de despacho, paso 2). Es
 * una pista: herdr es efímero y `ensureWorkspace` lo revalida; db lo implementa.
 */
export interface ProjectWorkspaceStore {
  get(projectId: string): string | null;
  record(projectId: string, workspaceId: string): void;
}
