// Tasks' PRs (ADR uw-14-adapter-github). It only touches `pr_url` and `pr_state`: the task's
// state changes only through task-transitions (ADR 0007), also when a PR in conflict
// reopens it (ADR pr-en-conflicto). Each change leaves its event published in
// the outbox, so the scheduler recalculates the ready set when a PR is merged or closed.
import {
  type ObservedPrState,
  type PrTrackingStore,
  prStateChange,
  type TrackedPr,
} from "@lunasq/domain";
import {
  DELIVERY_CONFLICT,
  DeliveryConflictPayload,
  TASK_PR_OPENED,
  TASK_PR_STATE_CHANGED,
  TaskPrOpenedPayload,
  TaskPrStateChangedPayload,
} from "@lunasq/schemas";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import { projects, runs, tasks } from "./schema.ts";
import { applyTransition } from "./task-transitions.ts";

export type TaskPrErrorCode = "task_not_found" | "pr_already_merged" | "pr_already_open";

export class TaskPrError extends Error {
  readonly code: TaskPrErrorCode;

  constructor(code: TaskPrErrorCode, message: string) {
    super(message);
    this.name = "TaskPrError";
    this.code = code;
  }
}

export class TaskPrRepository implements PrTrackingStore {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  listOpen(): TrackedPr[] {
    return this.db
      .select({ taskId: tasks.id, url: tasks.prUrl })
      .from(tasks)
      .where(and(eq(tasks.prState, "open"), isNotNull(tasks.prUrl)))
      .orderBy(asc(sql`rowid`))
      .all()
      .flatMap((row) => (row.url ? [{ taskId: row.taskId, url: row.url }] : []));
  }

  recordPrOpened(taskId: string, url: string): boolean {
    const payload = TaskPrOpenedPayload.parse({ url, previousUrl: null });
    return this.#write((tx) => {
      const row = tx
        .select({ prUrl: tasks.prUrl, prState: tasks.prState })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get();
      if (!row) throw new TaskPrError("task_not_found", `task ${taskId} does not exist`);
      if (row.prUrl === url && row.prState === "open") return false;
      if (row.prState === "merged") {
        throw new TaskPrError(
          "pr_already_merged",
          `the PR of ${taskId} was already merged: ${row.prUrl}`,
        );
      }
      // Replacing an open PR would take it out of the poller: if a human merges it, nobody would see it.
      if (row.prState === "open") {
        throw new TaskPrError("pr_already_open", `task ${taskId} already has ${row.prUrl} open`);
      }
      tx.update(tasks).set({ prUrl: url, prState: "open" }).where(eq(tasks.id, taskId)).run();
      appendEvent(
        tx,
        {
          taskId,
          type: TASK_PR_OPENED,
          actor: "system",
          payload: { ...payload, previousUrl: row.prUrl === url ? null : row.prUrl },
        },
        { publish: true },
      );
      return true;
    });
  }

  recordPrState(taskId: string, observed: ObservedPrState): boolean {
    return this.#write((tx) => {
      const row = tx
        .select({ prUrl: tasks.prUrl, prState: tasks.prState })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get();
      // A PR different from the current one (an old one of the task) changes nothing.
      if (!row || row.prUrl !== observed.url) return false;
      const to = prStateChange(row.prState, observed.state);
      if (!to) return false;
      tx.update(tasks)
        .set({ prState: to })
        .where(and(eq(tasks.id, taskId), eq(tasks.prState, "open"), eq(tasks.prUrl, observed.url)))
        .run();
      const payload = TaskPrStateChangedPayload.parse({
        url: observed.url,
        from: "open",
        to,
        at: observed.at?.toISOString() ?? null,
      });
      appendEvent(
        tx,
        { taskId, type: TASK_PR_STATE_CHANGED, actor: "system", payload },
        { publish: true },
      );
      return true;
    });
  }

  recordPrConflict(taskId: string, url: string): boolean {
    return this.#recordPrFailure(taskId, url, "pr_conflict", null);
  }

  recordPrCiFailure(taskId: string, url: string, output: string): boolean {
    return this.#recordPrFailure(taskId, url, "ci_failed", output);
  }

  #recordPrFailure(
    taskId: string,
    url: string,
    reason: "pr_conflict" | "ci_failed",
    output: string | null,
  ): boolean {
    return this.#write((tx) => {
      const row = tx
        .select({
          state: tasks.state,
          prUrl: tasks.prUrl,
          prState: tasks.prState,
          baseBranch: projects.baseBranch,
        })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(eq(tasks.id, taskId))
        .get();
      if (row?.state !== "completed" || row.prUrl !== url || row.prState !== "open") {
        return false;
      }
      // The Run of the verifier that gave the delivered pass: the event requires it and audits it.
      const verifier = tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.taskId, taskId), eq(runs.phase, "verify")))
        .orderBy(desc(runs.startedAt), desc(sql`rowid`))
        .limit(1)
        .get();
      if (!verifier) return false;
      const moved = applyTransition(tx, {
        taskId,
        actor: "system",
        command: { type: "delivery_conflict" },
        expected: { state: "completed", subState: null },
      });
      if (!moved.ok) return false;
      const payload = DeliveryConflictPayload.parse({
        runId: verifier.id,
        reason,
        baseBranch: row.baseBranch,
        files: [],
        output,
      });
      appendEvent(
        tx,
        { taskId, type: DELIVERY_CONFLICT, actor: "system", payload },
        { publish: true },
      );
      return true;
    });
  }

  // IMMEDIATE takes the write lock before reading: two pollers (server and CLI) do not record
  // the same merge twice.
  #write<T>(fn: (tx: Parameters<Parameters<LunasqDatabase["transaction"]>[0]>[0]) => T): T {
    return this.db.transaction(fn, { behavior: "immediate" });
  }
}
