// Agent Questions to the human (docs/design.md §Agent questions and blocks,
// ADR uw-22-preguntas). `createQuestion` lives in runs.ts because the LunasQ MCP uses it; here are
// the answer, the query and the cancellation.
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
  /** The agent's pane is still alive: the task goes back to running; otherwise, to queued (new Run). */
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

  /** Oldest first (rowid breaks the tie within the same millisecond): the order in which they wait for the human. */
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

  /** The task's open question: `ask_human` rejects a second one, so there is at most one. */
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
   * Stores the answer and applies `answer` in a single transaction: the Question, the transition and
   * the events commit together or not at all. Answering twice is rejected (`not_open`).
   */
  answer(id: string, input: AnswerQuestionInput): AnswerQuestionResult {
    const fail = (code: AnswerQuestionErrorCode, message: string): AnswerQuestionResult => ({
      ok: false,
      error: { code, message },
    });
    return this.db.transaction(
      (tx) => {
        const question = tx.select().from(questions).where(eq(questions.id, id)).get();
        if (!question) return fail("not_found", `question ${id} does not exist`);
        if (question.status !== "open") {
          return fail("not_open", `question ${id} is ${question.status}`);
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
        if (!row) return fail("not_open", `question ${id} is no longer open`);
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

  /** Cancels the task's open questions (cancellation or exit from waiting_human). */
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
