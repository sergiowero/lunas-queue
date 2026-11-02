// Read-only routes for the front end (ADR uw-21-front-end): global queue with the
// scheduler's score and, per task, Runs, Event log, usage and evidence file.
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

/** Path of the evidence file inside the repo (written and committed by the evidence service). */
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
 * Task evidence: from the worktree while it exists; otherwise from its branch and, after the merge (the
 * branch may have been deleted), from the base branch. Reads refs already present in the project repo,
 * without fetch: a UI read does not touch the network. A missing ref or an inaccessible repo counts
 * as "not there".
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
 * Ready set first, in the scheduler's order and with its score; then the other live tasks in
 * the listing order (priority, age). Terminal ones are not in the queue.
 */
function queue(deps: ViewDeps, projectId: string | undefined): QueueEntry[] {
  // A single transaction: the ready set and each task's state come from the same read.
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
  // sort is stable: those not in the ready set keep the listing order.
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

/** Mounted under /api/tasks next to taskRoutes. */
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
