// Reads that feed the task detail and the front end queue (UW-21, ADR uw-21-front-end):
// Runs without their token, Event log and aggregated usage. Read-only; nothing here changes state.
import {
  AgentKind,
  EMPTY_USAGE,
  EventView,
  HOOK_EXECUTED,
  HookExecutedPayload,
  type HookExecutionView,
  REVIEWER_NAMES,
  RunView,
  SETTINGS_UPDATED,
  type TaskUsage,
  type UsagePhase,
  type UsageTotals,
} from "@lunasq/schemas";
import { and, asc, eq, getTableColumns, gt, inArray, max, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { listEvents } from "./event-log.ts";
import { events, runSubagents, runs, tasks, usageRecords } from "./schema.ts";

const {
  runToken: _token,
  launchedAt: _launched,
  contextReadAt: _read,
  ...runColumns
} = getTableColumns(runs);

// SUM returns NULL without rows; tokens are read as 0. The cost is only summed if all the
// records bring it: a partial total would read as complete.
const totals = {
  inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`,
  outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`,
  cacheReadTokens: sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)`,
  cacheWriteTokens: sql<number>`coalesce(sum(${usageRecords.cacheWriteTokens}), 0)`,
  costUsd: sql<
    number | null
  >`case when count(${usageRecords.costUsd}) = count(*) then sum(${usageRecords.costUsd}) end`,
};

// Rework is the implementation Runs of a verification iteration after the first.
const PHASE_ORDER: UsagePhase[] = ["refine", "implement", "rework", "verify", "deliver"];
const usagePhase = sql<UsagePhase>`case when ${runs.phase} = 'implement' and ${runs.iteration} > 0 then 'rework' else ${runs.phase} end`;

function toTotals(row: UsageTotals): UsageTotals {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd,
  };
}

export class TaskViewRepository {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  /** Runs of the task from oldest to newest; null if the task does not exist. */
  runs(taskId: string): RunView[] | null {
    if (!this.exists(taskId)) return null;
    return this.db
      .select(runColumns)
      .from(runs)
      .where(eq(runs.taskId, taskId))
      .orderBy(asc(runs.startedAt), asc(sql`${runs}.rowid`))
      .all()
      .map((row) => RunView.parse(row));
  }

  /** The task's Event log in write order; null if the task does not exist. */
  events(taskId: string): EventView[] | null {
    if (!this.exists(taskId)) return null;
    return listEvents(this.db, taskId).map((row) => EventView.parse(row));
  }

  /** Usage per Run (only Runs with records) and total; null if the task does not exist. */
  usage(taskId: string): TaskUsage | null {
    if (!this.exists(taskId)) return null;
    const byRun = this.db
      .select({ runId: runs.id, phase: runs.phase, ...totals })
      .from(usageRecords)
      .innerJoin(runs, eq(usageRecords.runId, runs.id))
      .where(eq(runs.taskId, taskId))
      .groupBy(runs.id)
      .orderBy(asc(runs.startedAt), asc(sql`${runs}.rowid`))
      .all();
    const total = this.db
      .select(totals)
      .from(usageRecords)
      .innerJoin(runs, eq(usageRecords.runId, runs.id))
      .where(eq(runs.taskId, taskId))
      .get();
    const grouped = <C>(column: C, ...extra: Parameters<typeof and>) =>
      this.db
        .select({ key: sql<string>`${column}`, ...totals })
        .from(usageRecords)
        .innerJoin(runs, eq(usageRecords.runId, runs.id))
        .where(and(eq(runs.taskId, taskId), ...extra));
    const byPhase = grouped(usagePhase).groupBy(usagePhase).all();
    const byAgent = grouped(runs.agentKind)
      .groupBy(runs.agentKind)
      .orderBy(asc(runs.agentKind))
      .all();
    const byModel = grouped(usageRecords.model)
      .groupBy(usageRecords.model)
      .orderBy(asc(usageRecords.model))
      .all();
    // Only the verification reviewers: joined by the agent_id the hooks recorded.
    const byReviewer = grouped(
      runSubagents.agentType,
      inArray(runSubagents.agentType, [...REVIEWER_NAMES]),
    )
      .innerJoin(
        runSubagents,
        and(
          eq(runSubagents.runId, usageRecords.runId),
          eq(runSubagents.agentId, usageRecords.agentId),
        ),
      )
      .groupBy(runSubagents.agentType)
      .orderBy(asc(runSubagents.agentType))
      .all();
    return {
      total: total ? toTotals(total) : EMPTY_USAGE,
      byRun: byRun.map(({ runId, phase, ...usage }) => ({
        runId,
        phase,
        usage: toTotals(usage),
      })),
      byPhase: byPhase
        .map(({ key, ...usage }) => ({ phase: key as UsagePhase, usage: toTotals(usage) }))
        .sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase)),
      byAgent: byAgent.map(({ key, ...usage }) => ({
        agentKind: AgentKind.parse(key),
        usage: toTotals(usage),
      })),
      byModel: byModel.map(({ key, ...usage }) => ({ model: key, usage: toTotals(usage) })),
      byReviewer: byReviewer.map(({ key, ...usage }) => ({
        reviewer: key,
        usage: toTotals(usage),
      })),
    };
  }

  /** Total usage per task, for the queue column; tasks without records do not appear. */
  usageByTask(): Map<string, UsageTotals> {
    const rows = this.db
      .select({ taskId: runs.taskId, ...totals })
      .from(usageRecords)
      .innerJoin(runs, eq(usageRecords.runId, runs.id))
      .groupBy(runs.taskId)
      .all();
    return new Map(rows.map(({ taskId, ...usage }) => [taskId, toTotals(usage)]));
  }

  /** Id of the last written event; 0 without events. It is the change stream's cursor. */
  lastEventId(): number {
    return (
      this.db
        .select({ id: max(events.id) })
        .from(events)
        .get()?.id ?? 0
    );
  }

  /**
   * Tasks with events after `afterId`, in order of their first new event, and the id of the
   * last one. Every task change leaves an event (ADR 0007), so it is enough to invalidate the UI.
   * `settingsChanged` reports a settings.updated, which is global and does not appear in `taskIds`.
   */
  changesSince(afterId: number): {
    lastId: number;
    taskIds: string[];
    settingsChanged: boolean;
  } {
    const rows = this.db
      .select({ id: events.id, taskId: events.taskId, type: events.type })
      .from(events)
      .where(gt(events.id, afterId))
      .orderBy(asc(events.id))
      .all();
    return {
      lastId: rows.at(-1)?.id ?? afterId,
      // Global events (settings.updated) do not belong to any task.
      taskIds: [...new Set(rows.flatMap((r) => (r.taskId === null ? [] : [r.taskId])))],
      settingsChanged: rows.some((r) => r.type === SETTINGS_UPDATED),
    };
  }

  /**
   * Latest hook executions (hook.executed) of the project: the most recent of each task in
   * each script, and at most `perHook` tasks (the most recent) per point and script, so a hook
   * that runs rarely is not lost behind the executions of others. Newest first. A payload
   * that does not meet the schema is skipped: the Event log is append-only and is not corrected.
   */
  hookExecutions(projectId: string, perHook: number): HookExecutionView[] {
    const hook = (alias: string) =>
      sql.raw(
        `json_extract(${alias}payload, '$.point'), json_extract(${alias}payload, '$.script')`,
      );
    const rows = this.db.all<{
      eventId: number;
      taskId: string;
      taskIntent: string;
      taskTitle: string | null;
      at: number;
      payload: string | null;
    }>(sql`
      with latest as (
        select e.id, e.task_id, t.intent, t.title, e.created_at, e.payload,
          row_number() over (
            partition by e.task_id, ${hook("e.")} order by e.id desc
          ) as per_task
        from events e join tasks t on t.id = e.task_id
        where t.project_id = ${projectId} and e.type = ${HOOK_EXECUTED}
      ), ranked as (
        select *, row_number() over (partition by ${hook("")} order by id desc) as per_hook
        from latest where per_task = 1
      )
      select id as eventId, task_id as taskId, intent as taskIntent, title as taskTitle, created_at as at, payload
      from ranked where per_hook <= ${perHook} order by id desc
    `);
    const result: HookExecutionView[] = [];
    for (const { payload, at, ...row } of rows) {
      const parsed = HookExecutedPayload.safeParse(payload === null ? null : JSON.parse(payload));
      if (parsed.success) result.push({ ...row, at: new Date(at), ...parsed.data });
    }
    return result;
  }

  private exists(taskId: string): boolean {
    return (
      this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).get() !== undefined
    );
  }
}
