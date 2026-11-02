// The human's answer to a Question (docs/design.md §Agent questions and blocks,
// ADR uw-22-preguntas). If the agent is still alive in its pane, the answer enters as a new prompt;
// if not, the task goes back to queued and the answer arrives in `get_task_context` of the next Run.
import type { HerdrAdapter } from "@lunasq/adapters";
import {
  type AnswerQuestionErrorCode,
  type LunasqDatabase,
  QuestionRepository,
  type QuestionRow,
  RunRepository,
  type RunRow,
  TaskRepository,
} from "@lunasq/db";
import { answerPrompt, pendingPhase } from "@lunasq/domain";
import type { QuestionAnswer, QuestionDelivery, SchedulablePhase } from "@lunasq/schemas";
import type { PhaseDispatcher } from "../dispatcher/dispatcher.ts";
import type { Escalator } from "../notifications/escalator.ts";
import { KeyedLock } from "../worktrees/keyed-lock.ts";
import { questionNotificationId } from "./escalations.ts";

export type AnswerOutcome =
  | { ok: true; question: QuestionRow; delivery: QuestionDelivery }
  | { ok: false; error: { code: AnswerQuestionErrorCode; message: string } };

export interface QuestionServiceOptions {
  db: LunasqDatabase;
  herdr: Pick<HerdrAdapter, "getAgent" | "promptAgent">;
  dispatcher: Pick<PhaseDispatcher, "closeRun">;
  escalator: Pick<Escalator, "resolve">;
  /** After confirming the answer: wakes the scheduler to dispatch the new Run. */
  onAnswered?: () => void;
  onError?: (error: Error, questionId: string) => void;
}

export class QuestionService {
  private readonly questions: QuestionRepository;
  private readonly runs: RunRepository;
  private readonly tasks: TaskRepository;
  private readonly herdr: QuestionServiceOptions["herdr"];
  private readonly dispatcher: QuestionServiceOptions["dispatcher"];
  private readonly escalator: QuestionServiceOptions["escalator"];
  private readonly onAnswered: () => void;
  private readonly onError: (error: Error, questionId: string) => void;
  // One answer at a time per question: two clients do not send two prompts to the same agent.
  private readonly locks = new KeyedLock();

  constructor(opts: QuestionServiceOptions) {
    this.questions = new QuestionRepository(opts.db);
    this.runs = new RunRepository(opts.db);
    this.tasks = new TaskRepository(opts.db);
    this.herdr = opts.herdr;
    this.dispatcher = opts.dispatcher;
    this.escalator = opts.escalator;
    this.onAnswered = opts.onAnswered ?? (() => {});
    this.onError = opts.onError ?? defaultError;
  }

  answer(id: string, input: QuestionAnswer): Promise<AnswerOutcome> {
    return this.locks.run(id, () => this.deliver(id, input));
  }

  private async deliver(id: string, input: QuestionAnswer): Promise<AnswerOutcome> {
    const question = this.questions.get(id);
    if (!question) return notFound(id);
    if (question.status !== "open") return notOpen(id, question.status);
    const task = this.tasks.get(question.taskId);
    if (task?.subState !== "waiting_human") {
      return taskNotWaiting(id, task ? `${task.state}/${task.subState ?? "-"}` : "inexistente");
    }
    const run = question.runId ? this.runs.get(question.runId) : null;
    const phase = pendingPhase(task.state);

    // The prompt first: if herdr rejects it, the answer goes in a new Run without being lost. The
    // prompt arrives before the transition to running, but the agent takes longer to act.
    const prompted =
      run && phase
        ? await this.prompt(run, phase, task.id, question.question, input.answer, id)
        : false;

    const result = this.questions.answer(id, {
      answer: input.answer,
      ...(input.answeredBy === undefined ? {} : { answeredBy: input.answeredBy }),
      agentAlive: prompted,
    });
    if (!result.ok) return result;
    this.escalator.resolve(questionNotificationId(id));

    if (!prompted && run) {
      try {
        await this.dispatcher.closeRun(run.id, {
          result: "cancelled",
          failureReason:
            "question_answered: the agent was no longer alive; the answer arrives in a new Run",
        });
      } catch (error) {
        // Reconciliation closes the Run of a task that is no longer in its phase.
        this.onError(asError(error), id);
      }
    }
    this.onAnswered();
    return { ok: true, question: result.question, delivery: prompted ? "pane" : "new_run" };
  }

  /** Sends the answer to the Run's pane. false if the agent is no longer there or herdr does not accept it. */
  private async prompt(
    run: RunRow,
    phase: SchedulablePhase,
    taskId: string,
    question: string,
    answer: string,
    questionId: string,
  ): Promise<boolean> {
    if (run.endedAt !== null || !run.herdrName || !run.herdrPane) return false;
    try {
      const agent = await this.herdr.getAgent(run.herdrName);
      if (!agent || agent.paneId !== run.herdrPane) return false;
      await this.herdr.promptAgent({
        name: run.herdrName,
        text: answerPrompt(phase, taskId, { question, answer }),
      });
      return true;
    } catch (error) {
      this.onError(asError(error), questionId);
      return false;
    }
  }
}

const notFound = (id: string): AnswerOutcome => ({
  ok: false,
  error: { code: "not_found", message: `question ${id} does not exist` },
});
const notOpen = (id: string, status: string): AnswerOutcome => ({
  ok: false,
  error: { code: "not_open", message: `question ${id} is ${status}` },
});
const taskNotWaiting = (id: string, position: string): AnswerOutcome => ({
  ok: false,
  error: {
    code: "task_not_waiting",
    message: `the task of question ${id} is not waiting for the human (${position})`,
  },
});

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultError(error: Error, questionId: string): void {
  console.error(`[questions] failure in question ${questionId}: ${error.message}`);
}
