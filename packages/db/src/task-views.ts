// Lecturas que alimentan el detalle de tarea y la cola del front end (UW-21, ADR uw-21-front-end):
// Runs sin su token, Event log y usage agregado. Solo lee; nada aquí cambia estado.
import { EMPTY_USAGE, EventView, RunView, type TaskUsage, type UsageTotals } from "@lunasq/schemas";
import { asc, eq, getTableColumns, gt, max, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { listEvents } from "./event-log.ts";
import { events, runs, tasks, usageRecords } from "./schema.ts";

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
    return {
      total: total ? toTotals(total) : EMPTY_USAGE,
      byRun: byRun.map(({ runId, phase, ...usage }) => ({
        runId,
        phase,
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

  private exists(taskId: string): boolean {
    return (
      this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).get() !== undefined
    );
  }
}
