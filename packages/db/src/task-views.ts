// Lecturas que alimentan el detalle de tarea y la cola del front end (UW-21, ADR uw-21-front-end):
// Runs sin su token, Event log y usage agregado. Solo lee; nada aquí cambia estado.
import {
  EMPTY_USAGE,
  EventView,
  HOOK_EXECUTED,
  HookExecutedPayload,
  type HookExecutionView,
  REVIEWER_NAMES,
  RunView,
  type TaskGraph,
  type TaskUsage,
  type UsagePhase,
  type UsageTotals,
} from "@lunasq/schemas";
import { and, asc, eq, getTableColumns, gt, inArray, max, or, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { listEvents } from "./event-log.ts";
import { events, runSubagents, runs, taskDependencies, tasks, usageRecords } from "./schema.ts";
import { requireTaskNumber } from "./tasks.ts";

const {
  runToken: _token,
  launchedAt: _launched,
  contextReadAt: _read,
  ...runColumns
} = getTableColumns(runs);

// SUM devuelve NULL sin filas; los tokens se leen como 0. El costo solo se suma si todos los
// registros lo traen: un total parcial se leería como completo.
const totals = {
  inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`,
  outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`,
  cacheReadTokens: sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)`,
  cacheWriteTokens: sql<number>`coalesce(sum(${usageRecords.cacheWriteTokens}), 0)`,
  costUsd: sql<
    number | null
  >`case when count(${usageRecords.costUsd}) = count(*) then sum(${usageRecords.costUsd}) end`,
};

// El rework son los Runs de implementación de una iteración de verificación posterior a la primera.
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

  /** Runs de la tarea del más viejo al más nuevo; null si la tarea no existe. */
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

  /** Event log de la tarea en orden de escritura; null si la tarea no existe. */
  events(taskId: string): EventView[] | null {
    if (!this.exists(taskId)) return null;
    return listEvents(this.db, taskId).map((row) => EventView.parse(row));
  }

  /** Usage por Run (solo los Runs con registros) y total; null si la tarea no existe. */
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
    // Solo los revisores de verificación: se unen por el agent_id que registraron los hooks.
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
        agentKind: key as "claude",
        usage: toTotals(usage),
      })),
      byModel: byModel.map(({ key, ...usage }) => ({ model: key, usage: toTotals(usage) })),
      byReviewer: byReviewer.map(({ key, ...usage }) => ({
        reviewer: key,
        usage: toTotals(usage),
      })),
    };
  }

  /** Usage total por tarea, para la columna de la cola; las tareas sin registros no aparecen. */
  usageByTask(): Map<string, UsageTotals> {
    const rows = this.db
      .select({ taskId: runs.taskId, ...totals })
      .from(usageRecords)
      .innerJoin(runs, eq(usageRecords.runId, runs.id))
      .groupBy(runs.taskId)
      .all();
    return new Map(rows.map(({ taskId, ...usage }) => [taskId, toTotals(usage)]));
  }

  /** Id del último evento escrito; 0 sin eventos. Es el cursor del stream de cambios. */
  lastEventId(): number {
    return (
      this.db
        .select({ id: max(events.id) })
        .from(events)
        .get()?.id ?? 0
    );
  }

  /**
   * Tareas con eventos después de `afterId`, en orden de su primer evento nuevo, y el id del
   * último. Todo cambio de una tarea deja evento (ADR 0007), así que basta para invalidar la UI.
   */
  changesSince(afterId: number): { lastId: number; taskIds: string[] } {
    const rows = this.db
      .select({ id: events.id, taskId: events.taskId })
      .from(events)
      .where(gt(events.id, afterId))
      .orderBy(asc(events.id))
      .all();
    return {
      lastId: rows.at(-1)?.id ?? afterId,
      taskIds: [...new Set(rows.map((r) => r.taskId))],
    };
  }

  /**
   * El DAG de dependencias. Con `projectId`, sus tareas más las de otros proyectos al otro
   * extremo de una arista suya; sin él, todo. Las aristas son las de task_dependencies, sin
   * derivar nada. Una sola transacción: nodos y aristas salen del mismo estado.
   */
  graph(projectId?: string): TaskGraph {
    return this.db.transaction((tx) => {
      const inProject = tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.projectId, projectId ?? ""));
      const edges = tx
        .select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId })
        .from(taskDependencies)
        .where(
          projectId === undefined
            ? undefined
            : or(
                inArray(taskDependencies.taskId, inProject),
                inArray(taskDependencies.dependsOnId, inProject),
              ),
        )
        .orderBy(asc(sql`${taskDependencies}.rowid`))
        .all();
      const linked = [...new Set(edges.flatMap((e) => [e.taskId, e.dependsOnId]))];
      const nodes = tx
        .select({
          id: tasks.id,
          number: tasks.number,
          projectId: tasks.projectId,
          intent: tasks.intent,
          state: tasks.state,
          subState: tasks.subState,
          prState: tasks.prState,
          priority: tasks.priority,
        })
        .from(tasks)
        .where(
          projectId === undefined
            ? undefined
            : or(eq(tasks.projectId, projectId), inArray(tasks.id, linked)),
        )
        .orderBy(asc(tasks.createdAt), asc(sql`${tasks}.rowid`))
        .all()
        .map((node) => ({ ...node, number: requireTaskNumber(node.number) }));
      return { nodes, edges };
    });
  }

  /**
   * Últimas ejecuciones de hooks (hook.executed) del proyecto: la más reciente de cada tarea en
   * cada script, y a lo más `perHook` tareas (las más recientes) por punto y script, así un hook
   * que corre poco no se pierde tras las ejecuciones de otros. Las más nuevas primero. Un payload
   * que no cumple el esquema se salta: el Event log es append-only y no se corrige.
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
      at: number;
      payload: string | null;
    }>(sql`
      with latest as (
        select e.id, e.task_id, t.intent, e.created_at, e.payload,
          row_number() over (
            partition by e.task_id, ${hook("e.")} order by e.id desc
          ) as per_task
        from events e join tasks t on t.id = e.task_id
        where t.project_id = ${projectId} and e.type = ${HOOK_EXECUTED}
      ), ranked as (
        select *, row_number() over (partition by ${hook("")} order by id desc) as per_hook
        from latest where per_task = 1
      )
      select id as eventId, task_id as taskId, intent as taskIntent, created_at as at, payload
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
