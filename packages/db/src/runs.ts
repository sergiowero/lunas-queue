// Runs, Questions y checklist tal como los usa el LunasQ MCP (ADR uw-15-mcp-tools). Las
// funciones sueltas aceptan la base o una transacción abierta, para que la tool de salida cierre
// el Run en la misma transacción que la transición de la tarea.
import {
  CHECKLIST_UPDATED,
  type ChecklistItem,
  ChecklistUpdatedPayload,
  type Phase,
  QUESTION_CREATED,
  QuestionCreatedPayload,
  type RunResult,
  TASK_TRANSITIONED,
} from "@lunasq/schemas";
import { and, asc, desc, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import { events, questions, runs } from "./schema.ts";

export type RunRow = typeof runs.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;

type Reader = Pick<LunasqDatabase, "select">;
type Writer = Pick<LunasqDatabase, "select" | "insert" | "update" | "transaction">;

export class RunRepository {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  get(runId: string): RunRow | null {
    return this.db.select().from(runs).where(eq(runs.id, runId)).get() ?? null;
  }

  /** El Run activo (sin ended_at) con ese token; un token de un Run cerrado no cuenta. */
  activeByToken(token: string): RunRow | null {
    return (
      this.db
        .select()
        .from(runs)
        .where(and(eq(runs.runToken, token), isNull(runs.endedAt)))
        .get() ?? null
    );
  }

  /** Registra la primera lectura del contexto; repetir devuelve la misma fecha. */
  markContextRead(runId: string, at = new Date()): Date | null {
    this.db
      .update(runs)
      .set({ contextReadAt: at })
      .where(and(eq(runs.id, runId), isNull(runs.contextReadAt)))
      .run();
    return this.get(runId)?.contextReadAt ?? null;
  }

  /** Guarda el handoff sin cerrar el Run: el verificador con pass sigue abierto (ADR 0007). */
  recordHandoff(runId: string, handoff: unknown): void {
    this.db.update(runs).set({ handoff }).where(eq(runs.id, runId)).run();
  }

  /** Handoffs guardados de la fase, del Run más viejo al más nuevo. */
  handoffs(taskId: string, phase: Phase): unknown[] {
    return this.db
      .select({ handoff: runs.handoff })
      .from(runs)
      .where(and(eq(runs.taskId, taskId), eq(runs.phase, phase), isNotNull(runs.handoff)))
      .orderBy(asc(runs.startedAt))
      .all()
      .map((r) => r.handoff);
  }

  /** El último Run cerrado de la fase, sin contar `exceptRunId`: el intento anterior. */
  previousRun(taskId: string, phase: Phase, exceptRunId: string): RunRow | null {
    return (
      this.db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.taskId, taskId),
            eq(runs.phase, phase),
            ne(runs.id, exceptRunId),
            isNotNull(runs.endedAt),
          ),
        )
        .orderBy(desc(runs.startedAt))
        .limit(1)
        .get() ?? null
    );
  }
}

export type CloseRunInput = {
  result: RunResult;
  failureReason?: string;
  handoff?: unknown;
};

/** Cierra el Run si sigue abierto; false si ya estaba cerrado. */
export function closeRun(
  db: Writer,
  runId: string,
  input: CloseRunInput,
  at = new Date(),
): boolean {
  const closed = db
    .update(runs)
    .set({
      endedAt: at,
      result: input.result,
      failureReason: input.failureReason ?? null,
      ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
    })
    .where(and(eq(runs.id, runId), isNull(runs.endedAt)))
    .returning({ id: runs.id })
    .all();
  return closed.length > 0;
}

/**
 * Runs fallidos seguidos de la fase, del más nuevo hacia atrás, hasta uno que no falló o hasta
 * el último resume de la tarea: es el `attempt` de run_failed sin contar el Run que falla ahora.
 */
export function consecutiveFailures(db: Reader, taskId: string, phase: Phase): number {
  const lastResume = db
    .select({ at: events.createdAt })
    .from(events)
    .where(
      and(
        eq(events.taskId, taskId),
        eq(events.type, TASK_TRANSITIONED),
        sql`json_extract(${events.payload}, '$.command') = 'resume'`,
      ),
    )
    .orderBy(desc(events.id))
    .limit(1)
    .get();
  const closed = db
    .select({ result: runs.result })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.phase, phase),
        isNotNull(runs.endedAt),
        lastResume ? gt(runs.startedAt, lastResume.at) : undefined,
      ),
    )
    .orderBy(desc(runs.startedAt))
    .all();
  const firstOther = closed.findIndex((r) => r.result !== "failure");
  return firstOther === -1 ? closed.length : firstOther;
}

export type CreateQuestionInput = {
  taskId: string;
  runId: string;
  question: string;
  context?: string;
};

export function createQuestion(db: Writer, input: CreateQuestionInput): QuestionRow {
  return db.transaction((tx) => {
    const [row] = tx
      .insert(questions)
      .values({
        taskId: input.taskId,
        runId: input.runId,
        question: input.question,
        context: input.context ?? null,
      })
      .returning()
      .all();
    if (!row) throw new Error("insert de question sin fila");
    const payload = QuestionCreatedPayload.parse({ questionId: row.id, runId: input.runId });
    appendEvent(tx, { taskId: input.taskId, type: QUESTION_CREATED, actor: "agent", payload });
    return row;
  });
}

export function listQuestions(db: Reader, taskId: string): QuestionRow[] {
  return db
    .select()
    .from(questions)
    .where(eq(questions.taskId, taskId))
    .orderBy(asc(questions.createdAt), asc(questions.id))
    .all();
}

/** Agrega el snapshot completo del checklist al Event log. */
export function appendChecklist(
  db: Writer,
  taskId: string,
  runId: string,
  items: ChecklistItem[],
): void {
  const payload = ChecklistUpdatedPayload.parse({ runId, items });
  appendEvent(db, { taskId, type: CHECKLIST_UPDATED, actor: "agent", payload });
}

export function latestChecklist(db: Reader, taskId: string): ChecklistItem[] | null {
  const row = db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.taskId, taskId), eq(events.type, CHECKLIST_UPDATED)))
    .orderBy(desc(events.id))
    .limit(1)
    .get();
  return row ? ChecklistUpdatedPayload.parse(row.payload).items : null;
}
