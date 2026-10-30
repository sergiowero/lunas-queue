import { describe, expect, it } from "vitest";
import {
  BlockedAgent,
  QUESTION_ANSWERED,
  QUESTION_CANCELLED,
  Question,
  QuestionAnswer,
  QuestionAnsweredPayload,
  QuestionCancelledPayload,
  QuestionListQuery,
} from "./index.ts";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";

describe("QuestionAnswer", () => {
  it("exige texto y acepta quién responde", () => {
    expect(QuestionAnswer.parse({ answer: "Sí, bórrala" })).toEqual({ answer: "Sí, bórrala" });
    expect(QuestionAnswer.parse({ answer: "Sí", answeredBy: "sergio" }).answeredBy).toBe("sergio");
    expect(QuestionAnswer.safeParse({ answer: "  " }).success).toBe(false);
    expect(QuestionAnswer.safeParse({ answer: "x".repeat(2001) }).success).toBe(false);
    expect(QuestionAnswer.safeParse({}).success).toBe(false);
    expect(QuestionAnswer.safeParse({ answer: "ok", extra: 1 }).success).toBe(false);
  });
});

describe("QuestionListQuery", () => {
  it("filtra por estado, tarea y proyecto", () => {
    expect(QuestionListQuery.parse({})).toEqual({});
    expect(QuestionListQuery.parse({ status: "open", taskId: id, projectId: other })).toEqual({
      status: "open",
      taskId: id,
      projectId: other,
    });
    expect(QuestionListQuery.safeParse({ status: "closed" }).success).toBe(false);
    expect(QuestionListQuery.safeParse({ taskId: "no-uuid" }).success).toBe(false);
  });
});

describe("Question", () => {
  const base = {
    id,
    taskId: other,
    runId: id,
    question: "¿Borro la tabla?",
    context: null,
    status: "open",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: "2026-10-29T10:00:00.000Z",
  };

  it("acepta una pregunta abierta y una respondida", () => {
    expect(Question.safeParse(base).success).toBe(true);
    const answered = {
      ...base,
      status: "answered",
      answer: "Sí",
      answeredBy: "sergio",
      answeredAt: "2026-10-29T11:00:00.000Z",
    };
    expect(Question.safeParse(answered).success).toBe(true);
  });

  it("rechaza un estado desconocido", () => {
    expect(Question.safeParse({ ...base, status: "closed" }).success).toBe(false);
  });
});

describe("eventos de Question", () => {
  it("question.answered dice si la respuesta fue al pane vivo o a un Run nuevo", () => {
    expect(QUESTION_ANSWERED).toBe("question.answered");
    const ok = { questionId: id, runId: other, delivery: "pane", answeredBy: "sergio" };
    expect(QuestionAnsweredPayload.safeParse(ok).success).toBe(true);
    expect(QuestionAnsweredPayload.safeParse({ ...ok, delivery: "new_run" }).success).toBe(true);
    expect(QuestionAnsweredPayload.safeParse({ ...ok, delivery: "email" }).success).toBe(false);
    expect(QuestionAnsweredPayload.safeParse({ ...ok, runId: null }).success).toBe(true);
  });

  it("question.cancelled guarda la causa", () => {
    expect(QUESTION_CANCELLED).toBe("question.cancelled");
    expect(
      QuestionCancelledPayload.safeParse({ questionId: id, reason: "task_cancelled" }).success,
    ).toBe(true);
    expect(QuestionCancelledPayload.safeParse({ questionId: id }).success).toBe(false);
  });
});

describe("BlockedAgent", () => {
  const blocked = {
    runId: id,
    taskId: other,
    phase: "implement",
    agentName: "t1-implement-1",
    paneId: "p-1",
    since: "2026-10-29T12:00:00.000Z",
  };

  it("describe al agente que espera un permiso", () => {
    expect(BlockedAgent.safeParse(blocked).success).toBe(true);
    expect(BlockedAgent.safeParse({ ...blocked, phase: "deliver" }).success).toBe(false);
  });
});
