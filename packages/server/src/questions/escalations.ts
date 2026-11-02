// Notice of an open Question (docs/design.md §Signals and §Agent questions and blocks,
// ADR uw-22-preguntas): the question shows up immediately in the inbox (database query) and,
// if still open at 1 minute, is notified through herdr and the UI. It is built from the outbox
// (`task.transitioned`) and re-armed from the database on start. It also cancels the questions
// that stay open when the task leaves waiting_human without anyone answering them.
import {
  type LunasqDatabase,
  QuestionRepository,
  type QuestionRow,
  TaskRepository,
} from "@lunasq/db";
import {
  type OutboxMessage,
  type QuestionCancelledPayload,
  TASK_TRANSITIONED,
  TaskTransitionedPayload,
  taskLabel,
} from "@lunasq/schemas";
import type { Escalator } from "../notifications/escalator.ts";

export const questionNotificationId = (questionId: string): string => `question:${questionId}`;

export class QuestionEscalations {
  private readonly questions: QuestionRepository;
  private readonly tasks: TaskRepository;
  private readonly escalator: Pick<Escalator, "watch" | "resolve">;

  constructor(opts: { db: LunasqDatabase; escalator: Pick<Escalator, "watch" | "resolve"> }) {
    this.questions = new QuestionRepository(opts.db);
    this.tasks = new TaskRepository(opts.db);
    this.escalator = opts.escalator;
  }

  /** Transition of a task (outbox): idempotent, because the outbox delivers at least once. */
  onTransition(message: OutboxMessage): void {
    if (message.topic !== TASK_TRANSITIONED || message.taskId === null) return;
    const payload = TaskTransitionedPayload.safeParse(message.payload);
    if (!payload.success) return;
    const { from, to } = payload.data;
    const entered = to.subState === "waiting_human" && from.subState !== "waiting_human";
    if (entered) {
      const open = this.questions.openForTask(message.taskId);
      if (open) this.watch(open);
      return;
    }
    if (from.subState === "waiting_human" && to.subState !== "waiting_human") {
      this.leave(
        message.taskId,
        to.state === "cancelled" ? "task_cancelled" : "left_waiting_human",
      );
    }
  }

  /**
   * On start: re-arms the deadline of each open question from its creation date (the clock
   * lives in memory) and cancels those that no longer correspond to a task in waiting_human.
   */
  rearm(): void {
    for (const question of this.questions.list({ status: "open" })) {
      if (this.tasks.get(question.taskId)?.subState === "waiting_human") this.watch(question);
      else this.leave(question.taskId, "left_waiting_human");
    }
  }

  private watch(question: QuestionRow): void {
    const task = this.tasks.get(question.taskId);
    if (!task) return;
    this.escalator.watch(
      {
        id: questionNotificationId(question.id),
        kind: "question_open",
        taskId: question.taskId,
        ...(question.runId ? { runId: question.runId } : {}),
        title: `Open question in ${taskLabel(task.number)}`,
        body: question.question,
      },
      { since: question.createdAt },
    );
  }

  /**
   * The task left waiting_human: what remains open is canceled and no notice stays in force,
   * not even that of a question answered by another route.
   */
  private leave(taskId: string, reason: QuestionCancelledPayload["reason"]): void {
    this.questions.cancelOpen(taskId, reason);
    for (const question of this.questions.list({ taskId })) {
      this.escalator.resolve(questionNotificationId(question.id));
    }
  }
}
