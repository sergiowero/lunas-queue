// Rutas de solo lectura del front end (UW-21, ADR uw-21-front-end): cola global con el score del
// scheduler y, por tarea, Runs, Event log, usage y archivo de evidencia.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type GitAdapter, isGitError } from "@lunasq/adapters";
import type {
  LunasqDatabase,
  ProjectRepository,
  SchedulerStateRepository,
  TaskRepository,
  TaskViewRepository,
} from "@lunasq/db";
import { rankReady } from "@lunasq/domain";
import {
  EMPTY_USAGE,
  type QueueEntry,
  QueueQuery,
  type SchedulerConfig,
  type Task,
  type TaskEvidence,
  TaskGraphQuery,
} from "@lunasq/schemas";
import { Hono } from "hono";
import { invalidInput, notFound } from "./http.ts";

export interface ViewDeps {
  db: LunasqDatabase;
  tasks: TaskRepository;
  projects: ProjectRepository;
  views: TaskViewRepository;
  git: GitAdapter;
  state: SchedulerStateRepository;
  config: SchedulerConfig;
  now: () => Date;
}

/** Ruta del archivo de evidencia dentro del repo (UW-24 lo escribe y lo commitea). */
export function evidenceFile(taskId: string): string {
  return `lunasq/tasks/${taskId}.md`;
}

async function readWorktree(worktreePath: string, taskId: string): Promise<string | undefined> {
  try {
    return await readFile(join(worktreePath, evidenceFile(taskId)), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Evidencia de la tarea: del worktree mientras existe; si no, de su branch y, tras el merge (la
 * branch puede haberse borrado), de la rama base. Lee refs ya presentes en el repo del proyecto,
 * sin fetch: una lectura de la UI no toca la red. Un ref ausente o un repo inaccesible cuentan
 * como «no está».
 */
async function findEvidence(deps: ViewDeps, task: Task): Promise<TaskEvidence | null> {
  const file = evidenceFile(task.id);
  if (task.worktreePath) {
    const markdown = await readWorktree(task.worktreePath, task.id);
    if (markdown !== undefined) {
      return { source: "worktree", path: join(task.worktreePath, file), markdown };
    }
  }
  const project = deps.projects.get(task.projectId);
  if (!project) return null;
  const candidates: { source: "branch" | "base"; ref: string }[] = [];
  if (task.branch) {
    candidates.push({ source: "branch", ref: `origin/${task.branch}` });
    candidates.push({ source: "branch", ref: task.branch });
  }
  if (task.prState === "merged") {
    candidates.push({ source: "base", ref: `origin/${project.baseBranch}` });
  }
  for (const { source, ref } of candidates) {
    try {
      const commit = await deps.git.resolveCommit({ cwd: project.localPath, ref });
      const content = await deps.git.readFile({ cwd: project.localPath, commit, path: file });
      if (content) return { source, path: `${ref}:${file}`, markdown: content.toString("utf8") };
    } catch (error) {
      if (!isGitError(error)) throw error;
    }
  }
  return null;
}

/**
 * Ready set primero, en el orden y con el score del scheduler; después las demás tareas vivas en
 * el orden del listado (prioridad, antigüedad). Las terminales no están en la cola.
 */
function queue(deps: ViewDeps, projectId: string | undefined): QueueEntry[] {
  // Una sola transacción: el ready set y el estado de cada tarea salen de la misma lectura.
  const { snapshot, usage, listed } = deps.db.transaction(() => ({
    snapshot: deps.state.snapshot(),
    usage: deps.views.usageByTask(),
    listed: deps.tasks.list(projectId ? { projectId } : {}),
  }));
  const ranked = rankReady(snapshot, deps.config, deps.now());
  const rank = new Map(ranked.map((r, i) => [r.task.id, { ...r, position: i }]));
  const live = listed.filter((t) => t.state !== "completed" && t.state !== "cancelled");
  const entries = live.map((task): QueueEntry & { position: number } => {
    const totals = usage.get(task.id) ?? EMPTY_USAGE;
    const r = rank.get(task.id);
    return r
      ? {
          task,
          ready: true,
          score: r.score,
          effectivePriority: r.effectivePriority,
          usage: totals,
          position: r.position,
        }
      : {
          task,
          ready: false,
          score: null,
          effectivePriority: null,
          usage: totals,
          position: Number.POSITIVE_INFINITY,
        };
  });
  // sort es estable: las que no están en el ready set conservan el orden del listado.
  return entries
    .sort((a, b) => (a.position === b.position ? 0 : a.position - b.position))
    .map(({ position: _, ...entry }) => entry);
}

export function queueRoutes(deps: ViewDeps): Hono {
  return new Hono().get("/", (c) => {
    const query = QueueQuery.safeParse(c.req.query());
    if (!query.success) return invalidInput(c, query.error);
    return c.json(queue(deps, query.data.projectId));
  });
}

/** Se monta bajo /api/tasks junto a taskRoutes. */
export function taskViewRoutes(deps: ViewDeps): Hono {
  return new Hono()
    .get("/:id/runs", (c) => {
      const runs = deps.views.runs(c.req.param("id"));
      return runs ? c.json(runs) : notFound(c);
    })
    .get("/:id/events", (c) => {
      const events = deps.views.events(c.req.param("id"));
      return events ? c.json(events) : notFound(c);
    })
    .get("/:id/usage", (c) => {
      const usage = deps.views.usage(c.req.param("id"));
      return usage ? c.json(usage) : notFound(c);
    })
    .get("/:id/evidence", async (c) => {
      const task = deps.tasks.get(c.req.param("id"));
      if (!task) return notFound(c);
      const evidence = await findEvidence(deps, task);
      return evidence ? c.json(evidence) : c.json({ error: "evidence_not_found" }, 404);
    });
}

export function graphRoutes(deps: ViewDeps): Hono {
  return new Hono().get("/", (c) => {
    const query = TaskGraphQuery.safeParse(c.req.query());
    if (!query.success) return invalidInput(c, query.error);
    return c.json(deps.views.graph(query.data.projectId));
  });
}
