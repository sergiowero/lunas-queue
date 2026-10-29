// PR de las tareas (UW-14, ADR 0015). Solo toca `pr_url` y `pr_state`: el estado de la tarea
// cambia únicamente por task-transitions (ADR 0007). Cada cambio deja su evento publicado en el
// outbox, así el scheduler recalcula el ready set cuando un PR se mergea o se cierra.
import {
  type ObservedPrState,
  type PrTrackingStore,
  prStateChange,
  type TrackedPr,
} from "@lunasq/domain";
import {
  TASK_PR_OPENED,
  TASK_PR_STATE_CHANGED,
  TaskPrOpenedPayload,
  TaskPrStateChangedPayload,
} from "@lunasq/schemas";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import { tasks } from "./schema.ts";

export type TaskPrErrorCode = "task_not_found" | "pr_already_merged";

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
      if (!row) throw new TaskPrError("task_not_found", `no existe la tarea ${taskId}`);
      if (row.prUrl === url && row.prState === "open") return false;
      if (row.prState === "merged") {
        throw new TaskPrError("pr_already_merged", `el PR de ${taskId} ya se mergeó: ${row.prUrl}`);
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
      // Un PR distinto del actual (uno viejo de la tarea) no cambia nada.
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

  // IMMEDIATE toma el lock de escritura antes de leer: dos pollers (servidor y CLI) no registran
  // el mismo merge dos veces.
  #write<T>(fn: (tx: Parameters<Parameters<LunasqDatabase["transaction"]>[0]>[0]) => T): T {
    return this.db.transaction(fn, { behavior: "immediate" });
  }
}
