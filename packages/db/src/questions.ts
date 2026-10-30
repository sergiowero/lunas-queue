// Questions del agente al humano (docs/design.md §Preguntas del agente y bloqueos,
// ADR uw-22-preguntas). `createQuestion` vive en runs.ts porque lo usa el LunasQ MCP; aquí están
// la respuesta, la consulta y la cancelación.
import {
  QUESTION_ANSWERED,
  QUESTION_CANCELLED,
  type QuestionAnsweredPayload,
  type QuestionCancelledPayload,
  type QuestionListQuery,
} from "@lunasq/schemas";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import type { QuestionRow } from "./runs.ts";
import { questions, tasks } from "./schema.ts";
import { applyTransition, type TaskRow } from "./task-transitions.ts";

export type AnswerQuestionInput = {
  answer: string;
  answeredBy?: string;
  /** El pane del agente sigue vivo: la tarea vuelve a running; si no, a queued (Run nuevo). */
  agentAlive: boolean;
};

export type AnswerQuestionErrorCode = "not_found" | "not_open" | "task_not_waiting";

export type AnswerQuestionResult =
  | { ok: true; question: QuestionRow; task: TaskRow }
  | { ok: false; error: { code: AnswerQuestionErrorCode; message: string } };

export const DEFAULT_ANSWERER = "human";

export class QuestionRepository {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  get(id: string): QuestionRow | null {
    return this.db.select().from(questions).where(eq(questions.id, id)).get() ?? null;
  }

  /** Más viejas primero (rowid desempata el mismo milisegundo): el orden en que esperan al humano. */
  list(query: QuestionListQuery = {}): QuestionRow[] {
    const base = this.db
      .select({ question: questions })
      .from(questions)
      .innerJoin(tasks, eq(tasks.id, questions.taskId))
      .where(
        and(
          query.status ? eq(questions.status, query.status) : undefined,
          query.taskId ? eq(questions.taskId, query.taskId) : undefined,
          query.projectId ? eq(tasks.projectId, query.projectId) : undefined,
        ),
      )
      .orderBy(asc(questions.createdAt), sql`questions.rowid`);
    return base.all().map((r) => r.question);
  }

  /** La pregunta abierta de la tarea: `ask_human` rechaza una segunda, así que hay a lo sumo una. */
  openForTask(taskId: string): QuestionRow | null {
    return (
      this.db
        .select()
        .from(questions)
        .where(and(eq(questions.taskId, taskId), eq(questions.status, "open")))
        .orderBy(asc(questions.createdAt), sql`questions.rowid`)
        .get() ?? null
    );
  }

  /**
   * Guarda la respuesta y aplica `answer` en una sola transacción: la Question, la transición y
   * los eventos se confirman juntos o ninguno. Responder dos veces se rechaza (`not_open`).
   */
  answer(id: string, input: AnswerQuestionInput): AnswerQuestionResult {
    const fail = (code: AnswerQuestionErrorCode, message: string): AnswerQuestionResult => ({
      ok: false,
      error: { code, message },
    });
    return this.db.transaction(
      (tx) => {
        const question = tx.select().from(questions).where(eq(questions.id, id)).get();
        if (!question) return fail("not_found", `no existe la pregunta ${id}`);
        if (question.status !== "open") {
          return fail("not_open", `la pregunta ${id} está ${question.status}`);
        }
        const moved = applyTransition(tx, {
          taskId: question.taskId,
          actor: "human",
          command: { type: "answer", agentAlive: input.agentAlive },
        });
        if (!moved.ok) {
          const code = moved.error.code === "task_not_found" ? "not_found" : "task_not_waiting";
          return fail(code, moved.error.message);
        }
        const answeredBy = input.answeredBy ?? DEFAULT_ANSWERER;
        const [row] = tx
          .update(questions)
          .set({
            status: "answered",
            answer: input.answer,
            answeredBy,
            answeredAt: new Date(),
          })
          .where(and(eq(questions.id, id), eq(questions.status, "open")))
          .returning()
          .all();
        if (!row) return fail("not_open", `la pregunta ${id} ya no está abierta`);
        const payload: QuestionAnsweredPayload = {
          questionId: id,
          runId: question.runId,
          delivery: input.agentAlive ? "pane" : "new_run",
          answeredBy,
        };
        appendEvent(tx, {
          taskId: question.taskId,
          type: QUESTION_ANSWERED,
          actor: "human",
          payload,
        });
        return { ok: true, question: row, task: moved.task };
      },
      { behavior: "immediate" },
    );
  }

  /** Cancela las preguntas abiertas de la tarea (cancelación o salida de waiting_human). */
  cancelOpen(taskId: string, reason: QuestionCancelledPayload["reason"]): QuestionRow[] {
    return this.db.transaction(
      (tx) => {
        const open = tx
          .select({ id: questions.id })
          .from(questions)
          .where(and(eq(questions.taskId, taskId), eq(questions.status, "open")))
          .all();
        if (open.length === 0) return [];
        const rows = tx
          .update(questions)
          .set({ status: "cancelled" })
          .where(
            and(
              inArray(
                questions.id,
                open.map((q) => q.id),
              ),
              eq(questions.status, "open"),
            ),
          )
          .returning()
          .all();
        for (const row of rows) {
          const payload: QuestionCancelledPayload = { questionId: row.id, reason };
          appendEvent(tx, { taskId, type: QUESTION_CANCELLED, actor: "system", payload });
        }
        return rows;
      },
      { behavior: "immediate" },
    );
  }
}
