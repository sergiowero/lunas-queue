import { QUESTION_ANSWERED, QUESTION_CANCELLED, TASK_TRANSITIONED } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { listEvents } from "./event-log.ts";
import { QuestionRepository } from "./questions.ts";
import { createQuestion } from "./runs.ts";
import { outbox } from "./schema.ts";
import {
  insertProject,
  insertRun,
  insertTask,
  migratedDatabase,
  setTaskPosition,
} from "./test-helpers.ts";

function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const task = insertTask(db, project.id, { state: "in_progress", subState: "waiting_human" });
  const run = insertRun(db, task.id);
  const question = createQuestion(db, {
    taskId: task.id,
    runId: run.id,
    question: "¿Borro la tabla?",
  });
  return { db, project, task, run, question, questions: new QuestionRepository(db) };
}

describe("QuestionRepository.answer", () => {
  it("con el agente vivo guarda la respuesta y deja la tarea en running", () => {
    const { db, task, question, questions } = setup();
    const result = questions.answer(question.id, {
      answer: "Sí",
      answeredBy: "sergio",
      agentAlive: true,
    });
    expect(result).toMatchObject({
      ok: true,
      question: { status: "answered", answer: "Sí", answeredBy: "sergio" },
      task: { state: "in_progress", subState: "running" },
    });
    expect(listEvents(db, task.id).map((e) => e.type)).toEqual([
      "question.created",
      TASK_TRANSITIONED,
      QUESTION_ANSWERED,
    ]);
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      actor: "human",
      payload: { questionId: question.id, delivery: "pane", answeredBy: "sergio" },
    });
  });

  it("sin agente vivo la tarea vuelve a queued y la entrega es un Run nuevo", () => {
    const { db, task, question, questions } = setup();
    const result = questions.answer(question.id, { answer: "Sí", agentAlive: false });
    expect(result).toMatchObject({ ok: true, task: { subState: "queued" } });
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      payload: { delivery: "new_run", answeredBy: "human" },
    });
  });

  it("publica task.transitioned en el outbox, que despierta al scheduler", () => {
    const { db, question, questions } = setup();
    questions.answer(question.id, { answer: "Sí", agentAlive: true });
    const topics = db
      .select()
      .from(outbox)
      .all()
      .map((o) => o.topic);
    expect(topics).toContain(TASK_TRANSITIONED);
  });

  it("responder dos veces: la segunda se rechaza y no cambia nada", () => {
    const { db, task, question, questions } = setup();
    questions.answer(question.id, { answer: "Sí", agentAlive: true });
    const events = listEvents(db, task.id).length;
    const again = questions.answer(question.id, { answer: "No", agentAlive: true });
    expect(again).toMatchObject({ ok: false, error: { code: "not_open" } });
    expect(questions.get(question.id)?.answer).toBe("Sí");
    expect(listEvents(db, task.id)).toHaveLength(events);
  });

  it("si la tarea ya no espera al humano rechaza y revierte todo", () => {
    const { db, task, question, questions } = setup();
    setTaskPosition(db, task.id, { state: "needs_human", subState: null });
    const result = questions.answer(question.id, { answer: "Sí", agentAlive: true });
    expect(result).toMatchObject({ ok: false, error: { code: "task_not_waiting" } });
    expect(questions.get(question.id)?.status).toBe("open");
  });

  it("una pregunta inexistente responde not_found", () => {
    const { questions } = setup();
    expect(
      questions.answer("00000000-0000-4000-8000-000000000009", { answer: "x", agentAlive: true }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("QuestionRepository consultas", () => {
  it("lista por estado, tarea y proyecto, las más viejas primero", () => {
    const { db, project, task, question, questions } = setup();
    const otherTask = insertTask(db, project.id, {
      state: "in_progress",
      subState: "waiting_human",
    });
    const other = createQuestion(db, {
      taskId: otherTask.id,
      runId: insertRun(db, otherTask.id).id,
      question: "¿Y esta?",
    });
    expect(questions.list({ status: "open" }).map((q) => q.id)).toEqual([question.id, other.id]);
    expect(questions.list({ taskId: task.id }).map((q) => q.id)).toEqual([question.id]);
    expect(questions.list({ projectId: project.id })).toHaveLength(2);
    questions.answer(question.id, { answer: "Sí", agentAlive: true });
    expect(questions.list({ status: "open" }).map((q) => q.id)).toEqual([other.id]);
    expect(questions.list({ status: "answered" }).map((q) => q.id)).toEqual([question.id]);
  });

  it("openForTask devuelve la pregunta abierta de la tarea", () => {
    const { task, question, questions } = setup();
    expect(questions.openForTask(task.id)?.id).toBe(question.id);
    questions.answer(question.id, { answer: "Sí", agentAlive: true });
    expect(questions.openForTask(task.id)).toBeNull();
  });
});

describe("QuestionRepository.cancelOpen", () => {
  it("cancela las abiertas de la tarea y deja el evento", () => {
    const { db, task, question, questions } = setup();
    const cancelled = questions.cancelOpen(task.id, "task_cancelled");
    expect(cancelled.map((q) => q.id)).toEqual([question.id]);
    expect(questions.get(question.id)?.status).toBe("cancelled");
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      type: QUESTION_CANCELLED,
      payload: { questionId: question.id, reason: "task_cancelled" },
    });
  });

  it("repetirlo no duplica eventos ni toca las respondidas", () => {
    const { db, task, question, questions } = setup();
    questions.answer(question.id, { answer: "Sí", agentAlive: true });
    expect(questions.cancelOpen(task.id, "task_cancelled")).toEqual([]);
    expect(questions.get(question.id)?.status).toBe("answered");
    expect(listEvents(db, task.id).some((e) => e.type === QUESTION_CANCELLED)).toBe(false);
  });
});
