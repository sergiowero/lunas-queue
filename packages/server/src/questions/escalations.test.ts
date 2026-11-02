import { applyTransition, createQuestion, QuestionRepository } from "@lunasq/db";
import { insertProject, insertRun, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import type { Notification, OutboxMessage } from "@lunasq/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Escalator } from "../notifications/escalator.ts";
import { QuestionEscalations, questionNotificationId } from "./escalations.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const MIN = 60_000;

function setup() {
  const db = migratedDatabase();
  const task = insertTask(db, insertProject(db).id, {
    state: "in_progress",
    subState: "running",
  });
  const run = insertRun(db, task.id);
  const notifications: Notification[] = [];
  const escalator = new Escalator({ notify: (n) => void notifications.push(n) });
  const escalations = new QuestionEscalations({ db, escalator });
  const questions = new QuestionRepository(db);
  const ask = () => {
    applyTransition(db as never, {
      taskId: task.id,
      actor: "agent",
      command: { type: "ask_human" },
    });
    return createQuestion(db, { taskId: task.id, runId: run.id, question: "¿Borro la tabla?" });
  };
  return { db, task, run, notifications, escalator, escalations, questions, ask };
}

function transitioned(
  taskId: string,
  from: { state: string; subState: string | null },
  to: { state: string; subState: string | null },
): OutboxMessage {
  return {
    id: 1,
    eventId: 1,
    topic: "task.transitioned",
    taskId,
    actor: "agent",
    payload: { command: "ask_human", from, to, verificationIteration: 0 },
    createdAt: new Date().toISOString(),
  };
}

const running = { state: "in_progress", subState: "running" };
const waiting = { state: "in_progress", subState: "waiting_human" };

describe("QuestionEscalations", () => {
  it("notifies if the question is still open at 1 minute and not before", async () => {
    const s = setup();
    const question = s.ask();
    // The database timestamps with the real clock: the test clock is aligned with the creation.
    vi.setSystemTime(question.createdAt);
    s.escalations.onTransition(transitioned(s.task.id, running, waiting));

    await vi.advanceTimersByTimeAsync(MIN - 1);
    expect(s.notifications).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(s.notifications).toEqual([
      expect.objectContaining({
        id: questionNotificationId(question.id),
        kind: "question_open",
        taskId: s.task.id,
        runId: s.run.id,
        title: `Open question in #${s.task.number}`,
        body: expect.stringContaining("¿Borro la tabla?"),
      }),
    ]);
  });

  it("repeating the outbox transition does not duplicate the notice", async () => {
    const s = setup();
    s.ask();
    const message = transitioned(s.task.id, running, waiting);
    s.escalations.onTransition(message);
    s.escalations.onTransition(message);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.notifications).toHaveLength(1);
  });

  it("answering it before the minute cancels the notice", async () => {
    const s = setup();
    const question = s.ask();
    s.escalations.onTransition(transitioned(s.task.id, running, waiting));
    s.questions.answer(question.id, { answer: "Sí", agentAlive: true });
    s.escalations.onTransition(transitioned(s.task.id, waiting, running));

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.notifications).toEqual([]);
    expect(s.escalator.pending()).toEqual([]);
  });

  it("canceling the task cancels the question and its notice", async () => {
    const s = setup();
    const question = s.ask();
    s.escalations.onTransition(transitioned(s.task.id, running, waiting));
    s.escalations.onTransition(
      transitioned(s.task.id, waiting, { state: "cancelled", subState: null }),
    );

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.notifications).toEqual([]);
    expect(s.questions.get(question.id)?.status).toBe("cancelled");
  });

  it("if the task leaves waiting_human by another route, the question is canceled", () => {
    const s = setup();
    const question = s.ask();
    s.escalations.onTransition(
      transitioned(s.task.id, waiting, { state: "needs_human", subState: null }),
    );
    expect(s.questions.get(question.id)?.status).toBe("cancelled");
  });

  it("pausing the task with an open question cancels it and turns off its notice", async () => {
    const s = setup();
    const question = s.ask();
    s.escalations.onTransition(transitioned(s.task.id, running, waiting));
    const paused = applyTransition(s.db as never, {
      taskId: s.task.id,
      actor: "human",
      command: { type: "pause", deliveryInProgress: false },
    });
    expect(paused.ok).toBe(true);
    s.escalations.onTransition(
      transitioned(s.task.id, waiting, { state: "paused", subState: null }),
    );

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.notifications).toEqual([]);
    expect(s.questions.get(question.id)?.status).toBe("cancelled");
  });

  it("other transitions and other topics do nothing", async () => {
    const s = setup();
    s.ask();
    s.escalations.onTransition(transitioned(s.task.id, running, running));
    s.escalations.onTransition({
      ...transitioned(s.task.id, running, waiting),
      topic: "task.updated",
    });
    s.escalations.onTransition({
      ...transitioned(s.task.id, running, waiting),
      payload: { command: 1 },
    });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.notifications).toEqual([]);
  });

  describe("rearm after a restart", () => {
    it("re-arms the deadline from when the question was created", async () => {
      const s = setup();
      const question = s.ask();
      // The database timestamps with the real clock: the test clock is aligned with the creation.
      vi.setSystemTime(question.createdAt);
      await vi.advanceTimersByTimeAsync(40_000);
      s.escalations.rearm();

      await vi.advanceTimersByTimeAsync(19_999);
      expect(s.notifications).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.notifications).toHaveLength(1);
    });

    it("a question opened a while ago notifies immediately", async () => {
      const s = setup();
      s.ask();
      await vi.advanceTimersByTimeAsync(10 * MIN);
      s.escalations.rearm();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.notifications).toHaveLength(1);
    });

    it("cancels the open ones whose task no longer waits for the human", () => {
      const s = setup();
      const question = s.ask();
      s.db.$client.prepare("update tasks set sub_state = 'running' where id = ?").run(s.task.id);
      s.escalations.rearm();
      expect(s.questions.get(question.id)?.status).toBe("cancelled");
      expect(s.escalator.pending()).toEqual([]);
    });
  });
});
