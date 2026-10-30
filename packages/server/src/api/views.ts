// Rutas de solo lectura del front end (UW-21, ADR uw-21-front-end): cola global con el score del
// scheduler y, por tarea, Runs, Event log, usage y archivo de evidencia.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SchedulerStateRepository, TaskRepository, TaskViewRepository } from "@lunasq/db";
import { rankReady } from "@lunasq/domain";
import {
  EMPTY_USAGE,
  type QueueEntry,
  QueueQuery,
  type SchedulerConfig,
  type TaskEvidence,
} from "@lunasq/schemas";
import { Hono } from "hono";
import { invalidInput, notFound } from "./http.ts";

export interface ViewDeps {
  tasks: TaskRepository;
  views: TaskViewRepository;
  state: SchedulerStateRepository;
  config: SchedulerConfig;
  now: () => Date;
}

/** Ruta del archivo de evidencia que escribe UW-24 en el worktree de la tarea. */
export function evidencePath(worktreePath: string, taskId: string): string {
  return join(worktreePath, "lunasq", "tasks", `${taskId}.md`);
}

/**
 * Ready set primero, en el orden y con el score del scheduler; después las demás tareas vivas en
 * el orden del listado (prioridad, antigüedad). Las terminales no están en la cola.
 */
function queue(deps: ViewDeps, projectId: string | undefined): QueueEntry[] {
  const ranked = rankReady(deps.state.snapshot(), deps.config, deps.now());
  const rank = new Map(ranked.map((r, i) => [r.task.id, { ...r, position: i }]));
  const usage = deps.views.usageByTask();
  const live = deps.tasks
    .list(projectId ? { projectId } : {})
    .filter((t) => t.state !== "completed" && t.state !== "cancelled");
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
      if (!task.worktreePath) return c.json({ error: "evidence_not_found" }, 404);
      const path = evidencePath(task.worktreePath, task.id);
      try {
        const evidence: TaskEvidence = { path, markdown: await readFile(path, "utf8") };
        return c.json(evidence);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return c.json({ error: "evidence_not_found" }, 404);
        }
        throw error;
      }
    });
}
