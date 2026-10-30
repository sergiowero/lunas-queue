import { createQuestion } from "@lunasq/db";
import { insertProject, insertRun, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { Question } from "@lunasq/schemas";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { AnswerOutcome } from "../questions/service.ts";

const missing = "00000000-0000-4000-8000-000000000999";

function setup(answer?: (id: string, input: unknown) => Promise<AnswerOutcome>) {
  const db = migratedDatabase();
  const project = insertProject(db);
  const task = insertTask(db, project.id, { state: "in_progress", subState: "waiting_human" });
  const run = insertRun(db, task.id);
  const question = createQuestion(db, {
    taskId: task.id,
    runId: run.id,
    question: "¿Borro la tabla?",
    context: "hay dos",
  });
  const app = createApp({ db, ...(answer ? { questions: { answer } } : {}) });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  return { db, project, task, run, question, send };
}

describe("GET /api/questions", () => {
  it("lista las preguntas con el contrato Question", async () => {
    const { send, question, task, run } = setup();
    const res = await send("GET", "/api/questions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body.map((q) => Question.parse(q))).toEqual([
      expect.objectContaining({
        id: question.id,
        taskId: task.id,
        runId: run.id,
        status: "open",
        context: "hay dos",
        answer: null,
      }),
    ]);
  });

  it("filtra por estado, tarea y proyecto", async () => {
    const { send, task, project } = setup();
    const ids = async (query: string) =>
      ((await (await send("GET", `/api/questions${query}`)).json()) as unknown[]).length;
    expect(await ids("?status=open")).toBe(1);
    expect(await ids("?status=answered")).toBe(0);
    expect(await ids(`?taskId=${task.id}`)).toBe(1);
    expect(await ids(`?taskId=${missing}`)).toBe(0);
    expect(await ids(`?projectId=${project.id}`)).toBe(1);
  });

  it("responde 400 con un filtro inválido", async () => {
    const { send } = setup();
    expect((await send("GET", "/api/questions?status=closed")).status).toBe(400);
  });
});

describe("GET /api/questions/:id", () => {
  it("devuelve la pregunta o 404", async () => {
    const { send, question } = setup();
    const res = await send("GET", `/api/questions/${question.id}`);
    expect(res.status).toBe(200);
    expect(Question.parse(await res.json()).id).toBe(question.id);
    expect((await send("GET", `/api/questions/${missing}`)).status).toBe(404);
  });
});

describe("POST /api/questions/:id/answer", () => {
  const outcome = (delivery: "pane" | "new_run") =>
    vi.fn(async (id: string, _input: unknown): Promise<AnswerOutcome> => {
      const row = {
        id,
        taskId: missing,
        runId: null,
        question: "¿Borro la tabla?",
        context: null,
        status: "answered" as const,
        answer: "Sí",
        answeredBy: "human",
        answeredAt: new Date("2026-10-29T12:00:00.000Z"),
        createdAt: new Date("2026-10-29T11:00:00.000Z"),
      };
      return { ok: true, question: row, delivery };
    });

  it("responde 200 con la pregunta respondida y cómo se entregó", async () => {
    const answer = outcome("pane");
    const { send, question } = setup(answer);
    const res = await send("POST", `/api/questions/${question.id}/answer`, {
      answer: "Sí",
      answeredBy: "sergio",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question: unknown; delivery: string };
    expect(body.delivery).toBe("pane");
    expect(Question.parse(body.question)).toMatchObject({ status: "answered", answer: "Sí" });
    expect(answer).toHaveBeenCalledWith(question.id, { answer: "Sí", answeredBy: "sergio" });
  });

  it.each([
    ["not_found", 404],
    ["not_open", 409],
    ["task_not_waiting", 409],
  ] as const)("traduce %s a %i", async (code, status) => {
    const { send, question } = setup(async () => ({
      ok: false,
      error: { code, message: "x" },
    }));
    const res = await send("POST", `/api/questions/${question.id}/answer`, { answer: "Sí" });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: code });
  });

  it("responde 400 con JSON o respuesta inválidos sin llamar al servicio", async () => {
    const answer = outcome("pane");
    const { send, question } = setup(answer);
    expect((await send("POST", `/api/questions/${question.id}/answer`, "{no")).status).toBe(400);
    expect((await send("POST", `/api/questions/${question.id}/answer`, {})).status).toBe(400);
    expect(
      (await send("POST", `/api/questions/${question.id}/answer`, { answer: "  " })).status,
    ).toBe(400);
    expect(answer).not.toHaveBeenCalled();
  });

  it("responde 404 a una pregunta inexistente sin llamar al servicio", async () => {
    const answer = outcome("pane");
    const { send } = setup(answer);
    expect((await send("POST", `/api/questions/${missing}/answer`, { answer: "Sí" })).status).toBe(
      404,
    );
    expect(answer).not.toHaveBeenCalled();
  });

  it("sin servicio de respuestas responde 503", async () => {
    const { send, question } = setup();
    const res = await send("POST", `/api/questions/${question.id}/answer`, { answer: "Sí" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "answering_unavailable" });
  });
});

describe("GET /api/blocked", () => {
  it("lista los agentes bloqueados que reporta la fuente", async () => {
    const blocked = [
      {
        runId: missing,
        taskId: missing,
        phase: "implement" as const,
        agentName: "t1-implement-1",
        paneId: "p-1",
        since: "2026-10-29T12:00:00.000Z",
      },
    ];
    const db = migratedDatabase();
    const app = createApp({ db, blocked: () => blocked });
    const res = await app.request("/api/blocked");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(blocked);
  });

  it("sin fuente responde una lista vacía", async () => {
    const app = createApp({ db: migratedDatabase() });
    expect(await (await app.request("/api/blocked")).json()).toEqual([]);
  });
});
