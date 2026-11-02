import { HerdrError } from "@lunasq/adapters";
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
  it("lists the questions with the Question contract", async () => {
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
        options: null,
        answer: null,
      }),
    ]);
  });

  it("exposes the options of a multiple-choice question in the list and in the detail", async () => {
    const { send, db, task, run } = setup();
    const options = [{ label: "Sí", description: "borra la tabla" }, { label: "No" }];
    const withOptions = createQuestion(db, {
      taskId: task.id,
      runId: run.id,
      question: "¿Seguro?",
      options,
    });
    const list = (await (await send("GET", "/api/questions")).json()) as unknown[];
    expect(
      list.map((q) => Question.parse(q)).find((q) => q.id === withOptions.id)?.options,
    ).toEqual(options);
    const detail = Question.parse(
      await (await send("GET", `/api/questions/${withOptions.id}`)).json(),
    );
    expect(detail.options).toEqual(options);
  });

  it("filters by state, task and project", async () => {
    const { send, task, project } = setup();
    const ids = async (query: string) =>
      ((await (await send("GET", `/api/questions${query}`)).json()) as unknown[]).length;
    expect(await ids("?status=open")).toBe(1);
    expect(await ids("?status=answered")).toBe(0);
    expect(await ids(`?taskId=${task.id}`)).toBe(1);
    expect(await ids(`?taskId=${missing}`)).toBe(0);
    expect(await ids(`?projectId=${project.id}`)).toBe(1);
  });

  it("answers 400 with an invalid filter", async () => {
    const { send } = setup();
    expect((await send("GET", "/api/questions?status=closed")).status).toBe(400);
  });
});

describe("GET /api/questions/:id", () => {
  it("returns the question or 404", async () => {
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
        options: null,
        status: "answered" as const,
        answer: "Sí",
        answeredBy: "human",
        answeredAt: new Date("2026-10-29T12:00:00.000Z"),
        createdAt: new Date("2026-10-29T11:00:00.000Z"),
      };
      return { ok: true, question: row, delivery };
    });

  it("answers 200 with the answered question and how it was delivered", async () => {
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

  it("answers 400 with invalid JSON or answer without calling the service", async () => {
    const answer = outcome("pane");
    const { send, question } = setup(answer);
    expect((await send("POST", `/api/questions/${question.id}/answer`, "{no")).status).toBe(400);
    expect((await send("POST", `/api/questions/${question.id}/answer`, {})).status).toBe(400);
    expect(
      (await send("POST", `/api/questions/${question.id}/answer`, { answer: "  " })).status,
    ).toBe(400);
    expect(answer).not.toHaveBeenCalled();
  });

  it("answers 404 to a nonexistent question without calling the service", async () => {
    const answer = outcome("pane");
    const { send } = setup(answer);
    expect((await send("POST", `/api/questions/${missing}/answer`, { answer: "Sí" })).status).toBe(
      404,
    );
    expect(answer).not.toHaveBeenCalled();
  });

  it("without an answer service it answers 503", async () => {
    const { send, question } = setup();
    const res = await send("POST", `/api/questions/${question.id}/answer`, { answer: "Sí" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "answering_unavailable" });
  });
});

describe("GET /api/blocked", () => {
  it("lists the blocked agents the source reports", async () => {
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

  it("without a source it answers an empty list", async () => {
    const app = createApp({ db: migratedDatabase() });
    expect(await (await app.request("/api/blocked")).json()).toEqual([]);
  });
});

describe("POST /api/blocked/:runId/focus", () => {
  const agent = {
    runId: "00000000-0000-4000-8000-000000000001",
    taskId: missing,
    phase: "implement" as const,
    agentName: "t1-implement-1",
    paneId: "w1:p2",
    since: "2026-10-29T12:00:00.000Z",
  };
  const focusApp = (focus?: (name: string) => Promise<unknown>) =>
    createApp({ db: migratedDatabase(), blocked: () => [agent], ...(focus ? { focus } : {}) });
  const post = (app: ReturnType<typeof createApp>, runId: string) =>
    app.request(`/api/blocked/${runId}/focus`, { method: "POST" });

  it("focuses the Run's blocked agent in herdr", async () => {
    const focus = vi.fn(async () => undefined);
    const res = await post(focusApp(focus), agent.runId);
    expect(res.status).toBe(204);
    expect(focus).toHaveBeenCalledWith("t1-implement-1");
  });

  it("a Run that is not blocked answers 404 not_blocked without touching herdr", async () => {
    const focus = vi.fn(async () => undefined);
    const res = await post(focusApp(focus), missing);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_blocked" });
    expect(focus).not.toHaveBeenCalled();
  });

  it("if the agent no longer exists in herdr it answers 409 agent_gone", async () => {
    const res = await post(
      focusApp(async () => {
        throw new HerdrError("agent_not_found", "agent target t1-implement-1 not found");
      }),
      agent.runId,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "agent_gone" });
  });

  it("another herdr error answers 502 herdr_error with the message", async () => {
    const res = await post(
      focusApp(async () => {
        throw new HerdrError("server_unavailable", "herdr is not responding");
      }),
      agent.runId,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "herdr_error",
      message: expect.stringContaining("herdr is not responding"),
    });
  });

  it("without herdr it answers 503 focus_unavailable", async () => {
    const res = await post(focusApp(), agent.runId);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "focus_unavailable" });
  });
});
