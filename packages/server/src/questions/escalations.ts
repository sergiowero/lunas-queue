// Aviso de una Question abierta (docs/design.md §Señales y §Preguntas del agente y bloqueos,
// ADR uw-22-preguntas): la pregunta aparece de inmediato en la bandeja (consulta a la base) y,
// si sigue abierta a 1 minuto, se notifica por herdr y por la UI. Se arma desde el outbox
// (`task.transitioned`) y se re-arma desde la base al arrancar. También cancela las preguntas
// que quedan abiertas cuando la tarea sale de waiting_human sin que nadie las responda.
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

  /** Transición de una tarea (outbox): idempotente, porque el outbox entrega al menos una vez. */
  onTransition(message: OutboxMessage): void {
    if (message.topic !== TASK_TRANSITIONED) return;
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
   * Al arrancar: re-arma el plazo de cada pregunta abierta desde su fecha de creación (el reloj
   * vive en memoria) y cancela las que ya no corresponden a una tarea en waiting_human.
   */
  rearm(): void {
    for (const question of this.questions.list({ status: "open" })) {
      if (this.tasks.get(question.taskId)?.subState === "waiting_human") this.watch(question);
      else this.leave(question.taskId, "left_waiting_human");
    }
  }

  private watch(question: QuestionRow): void {
    this.escalator.watch(
      {
        id: questionNotificationId(question.id),
        kind: "question_open",
        taskId: question.taskId,
        ...(question.runId ? { runId: question.runId } : {}),
        title: `Pregunta abierta en ${question.taskId.slice(0, 8)}`,
        body: question.question,
      },
      { since: question.createdAt },
    );
  }

  /**
   * La tarea dejó waiting_human: lo que sigue abierto se cancela y ningún aviso queda vigente,
   * tampoco el de una pregunta que se respondió por otra vía.
   */
  private leave(taskId: string, reason: QuestionCancelledPayload["reason"]): void {
    this.questions.cancelOpen(taskId, reason);
    for (const question of this.questions.list({ taskId })) {
      this.escalator.resolve(questionNotificationId(question.id));
    }
  }
}
