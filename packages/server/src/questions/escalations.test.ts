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
  it("avisa si la pregunta sigue abierta a 1 minuto y no antes", async () => {
    const s = setup();
    const question = s.ask();
    // La base fecha con el reloj real: se alinea el reloj de prueba con la creación.
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
        title: `Pregunta abierta en #${s.task.number}`,
        body: expect.stringContaining("¿Borro la tabla?"),
      }),
    ]);
  });

  it("repetir la transición del outbox no duplica el aviso", async () => {
    const s = setup();
    s.ask();
    const message = transitioned(s.task.id, running, waiting);
    s.escalations.onTransition(message);
    s.escalations.onTransition(message);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.notifications).toHaveLength(1);
  });

  it("responderla antes del minuto cancela el aviso", async () => {
    const s = setup();
    const question = s.ask();
    s.escalations.onTransition(transitioned(s.task.id, running, waiting));
    s.questions.answer(question.id, { answer: "Sí", agentAlive: true });
    s.escalations.onTransition(transitioned(s.task.id, waiting, running));

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.notifications).toEqual([]);
    expect(s.escalator.pending()).toEqual([]);
  });

  it("cancelar la tarea cancela la pregunta y su aviso", async () => {
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

  it("si la tarea sale de waiting_human por otra vía, la pregunta se cancela", () => {
    const s = setup();
    const question = s.ask();
    s.escalations.onTransition(
      transitioned(s.task.id, waiting, { state: "needs_human", subState: null }),
    );
    expect(s.questions.get(question.id)?.status).toBe("cancelled");
  });

  it("otras transiciones y otros topics no hacen nada", async () => {
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

  describe("rearm tras un reinicio", () => {
    it("re-arma el plazo desde que se creó la pregunta", async () => {
      const s = setup();
      const question = s.ask();
      // La base fecha con el reloj real: se alinea el reloj de prueba con la creación.
      vi.setSystemTime(question.createdAt);
      await vi.advanceTimersByTimeAsync(40_000);
      s.escalations.rearm();

      await vi.advanceTimersByTimeAsync(19_999);
      expect(s.notifications).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.notifications).toHaveLength(1);
    });

    it("una pregunta abierta hace rato avisa de inmediato", async () => {
      const s = setup();
      s.ask();
      await vi.advanceTimersByTimeAsync(10 * MIN);
      s.escalations.rearm();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.notifications).toHaveLength(1);
    });

    it("cancela las abiertas cuyo tarea ya no espera al humano", () => {
      const s = setup();
      const question = s.ask();
      s.db.$client.prepare("update tasks set sub_state = 'running' where id = ?").run(s.task.id);
      s.escalations.rearm();
      expect(s.questions.get(question.id)?.status).toBe("cancelled");
      expect(s.escalator.pending()).toEqual([]);
    });
  });
});
