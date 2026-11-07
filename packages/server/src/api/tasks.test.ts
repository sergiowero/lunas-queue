import { listEvents, RunRepository, transitionTask } from "@lunasq/db";
import { insertProject, insertRun, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const missing = "00000000-0000-4000-8000-000000000999";

type TaskBody = { id: string; state: string; priority: number } & Record<string, unknown>;

function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const app = createApp({ db });
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const create = async (overrides: object = {}): Promise<TaskBody> => {
    const res = await send("POST", "/api/tasks", {
      projectId: project.id,
      goal: "Hacer algo",
      priority: 100,
      ...overrides,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as TaskBody;
  };
  return { db, project, send, create };
}

describe("POST /api/tasks", () => {
  it("creates the task in draft and answers 201", async () => {
    const { create, project } = setup();
    const task = await create({ tags: ["auth"] });
    expect(task).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      number: 1,
      projectId: project.id,
      goal: "Hacer algo",
      tags: ["auth"],
      priority: 100,
      state: "draft",
      subState: "queued",
    });
  });

  it("answers 400 with invalid JSON or invalid input", async () => {
    const { send, project } = setup();
    expect((await send("POST", "/api/tasks", "{")).status).toBe(400);
    const res = await send("POST", "/api/tasks", {
      projectId: project.id,
      goal: "x",
      priority: -1,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string[] }[] };
    expect(body.error).toBe("invalid_input");
    expect(body.issues[0]?.path).toEqual(["priority"]);
  });

  it("answers 400 if a task is created or patched with the former intent field", async () => {
    const { send, project } = setup();
    const created = await send("POST", "/api/tasks", {
      projectId: project.id,
      intent: "x",
      priority: 1,
    });
    expect(created.status).toBe(400);
    const withBoth = await send("POST", "/api/tasks", {
      projectId: project.id,
      goal: "x",
      intent: "x",
      priority: 1,
    });
    expect(withBoth.status).toBe(400);
    const task = (await (
      await send("POST", "/api/tasks", {
        projectId: project.id,
        goal: "x",
        priority: 1,
      })
    ).json()) as { id: string };
    expect((await send("PATCH", `/api/tasks/${task.id}`, { intent: "y" })).status).toBe(400);
  });

  it.each([
    ["project_not_found", { projectId: missing }],
    ["dependency_not_found", { dependsOn: [missing] }],
    ["caused_by_not_found", { causedBy: missing }],
  ])("answers 422 %s if a reference does not exist", async (code, overrides) => {
    const { send, project } = setup();
    const res = await send("POST", "/api/tasks", {
      projectId: project.id,
      goal: "Hacer algo",
      priority: 100,
      ...overrides,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: code });
  });
});

describe("GET /api/tasks", () => {
  it("lists ordered by priority and filters by project and state", async () => {
    const { send, create, db } = setup();
    const other = insertProject(db);
    const low = await create({ priority: 1 });
    const high = await create({ priority: 900 });
    const foreign = await create({ projectId: other.id });
    await send("POST", `/api/tasks/${low.id}/cancel`);

    const ids = async (query: string) =>
      ((await (await send("GET", `/api/tasks${query}`)).json()) as TaskBody[]).map((t) => t.id);
    expect(await ids("")).toEqual([high.id, foreign.id, low.id]);
    expect(await ids(`?projectId=${other.id}`)).toEqual([foreign.id]);
    expect(await ids("?state=cancelled")).toEqual([low.id]);
  });

  it("answers 400 with an invalid filter", async () => {
    const { send } = setup();
    expect((await send("GET", "/api/tasks?state=nuevo")).status).toBe(400);
    expect((await send("GET", "/api/tasks?projectId=p1")).status).toBe(400);
  });
});

describe("GET and PATCH /api/tasks/:id", () => {
  it("returns the task or 404", async () => {
    const { send, create } = setup();
    const task = await create();
    expect(await (await send("GET", `/api/tasks/${task.id}`)).json()).toMatchObject({
      id: task.id,
    });
    expect((await send("GET", `/api/tasks/${missing}`)).status).toBe(404);
  });

  it("AC-11: a task without a Result returns null resultKind and result", async () => {
    const { send, create } = setup();
    const task = await create();
    expect(await (await send("GET", `/api/tasks/${task.id}`)).json()).toMatchObject({
      resultKind: null,
      result: null,
    });
    const listed = (await (await send("GET", "/api/tasks")).json()) as TaskBody[];
    expect(listed[0]).toMatchObject({ resultKind: null, result: null });
  });

  it("a task completed with a Result returns its type and text, without a PR", async () => {
    const { send, db, project } = setup();
    const task = insertTask(db, project.id, {
      state: "completed",
      subState: null,
      resultKind: "already_implemented",
      result: "# Ya está\n\nVive en `src/x.ts`.",
    });
    const body = await (await send("GET", `/api/tasks/${task.id}`)).json();
    expect(body).toMatchObject({
      state: "completed",
      resultKind: "already_implemented",
      result: "# Ya está\n\nVive en `src/x.ts`.",
      prUrl: null,
      prState: null,
    });
    const listed = (await (await send("GET", "/api/tasks?state=completed")).json()) as TaskBody[];
    expect(listed[0]).toMatchObject({ resultKind: "already_implemented" });
  });

  it("updates goal, tags and priority", async () => {
    const { db, send, create } = setup();
    const task = await create();
    const res = await send("PATCH", `/api/tasks/${task.id}`, {
      goal: "A sharper goal",
      priority: 900,
      tags: ["ui"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ goal: "A sharper goal", priority: 900, tags: ["ui"] });
    const updated = listEvents(db, task.id).at(-1);
    expect(updated).toMatchObject({ type: "task.updated", actor: "human" });
    const payload = updated?.payload as {
      from: Record<string, unknown>;
      to: Record<string, unknown>;
    };
    expect(payload.from.goal).toBe(task.goal);
    expect(payload.to.goal).toBe("A sharper goal");
    expect(payload.from).not.toHaveProperty("intent");
    expect(payload.to).not.toHaveProperty("intent");
  });

  it("answers 400 if it tries to change the state, 404 if it does not exist and 409 if it is terminal", async () => {
    const { send, create } = setup();
    const task = await create();
    expect((await send("PATCH", `/api/tasks/${task.id}`, { state: "completed" })).status).toBe(400);
    expect((await send("PATCH", `/api/tasks/${missing}`, { priority: 1 })).status).toBe(404);
    await send("POST", `/api/tasks/${task.id}/cancel`);
    const res = await send("PATCH", `/api/tasks/${task.id}`, { priority: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "task_terminal" });
  });
});

describe("POST /api/tasks/:id/pause", () => {
  it("pauses a pausable task, answers 200 and records the event", async () => {
    const { db, send, create } = setup();
    const task = await create();
    const res = await send("POST", `/api/tasks/${task.id}/pause`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: task.id, state: "paused", subState: null });
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      type: "task.transitioned",
      actor: "human",
      payload: { command: "pause", from: { state: "draft", subState: "queued" } },
    });
  });

  it("answers 404 if it does not exist and 409 with the code if it is not pausable", async () => {
    const { send, create } = setup();
    const task = await create();
    await send("POST", `/api/tasks/${task.id}/cancel`);
    const res = await send("POST", `/api/tasks/${task.id}/pause`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "invalid_transition" });
    expect((await send("POST", `/api/tasks/${missing}/pause`)).status).toBe(404);
  });

  it("answers 409 guard_failed if the delivery is in progress and does not change the task", async () => {
    const { db, project, send } = setup();
    const task = insertTask(db, project.id, { state: "verification", subState: "running" });
    const run = insertRun(db, task.id, { phase: "verify" });
    new RunRepository(db).recordHandoff(run.id, { phase: "verification" });
    const res = await send("POST", `/api/tasks/${task.id}/pause`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "guard_failed" });
    expect(await (await send("GET", `/api/tasks/${task.id}`)).json()).toMatchObject({
      state: "verification",
      subState: "running",
    });
    expect(listEvents(db, task.id)).toEqual([]);
  });

  it("pauses a verification in progress without a saved pass", async () => {
    const { db, project, send } = setup();
    const task = insertTask(db, project.id, { state: "verification", subState: "running" });
    insertRun(db, task.id, { phase: "verify" });
    expect((await send("POST", `/api/tasks/${task.id}/pause`)).status).toBe(200);
  });
});

describe("POST /api/tasks/:id/resume", () => {
  it("resumes an escalated task to its previous state and records the event", async () => {
    const { db, send, create } = setup();
    const task = await create();
    transitionTask(db, {
      taskId: task.id,
      actor: "system",
      command: { type: "escalate", reason: "retries_exhausted" },
    });
    const res = await send("POST", `/api/tasks/${task.id}/resume`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "draft", subState: "queued" });
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      type: "task.transitioned",
      actor: "human",
      payload: { command: "resume" },
    });
  });

  it("resumes a paused task to its previous state", async () => {
    const { db, send, create } = setup();
    const task = await create();
    await send("POST", `/api/tasks/${task.id}/pause`);
    const res = await send("POST", `/api/tasks/${task.id}/resume`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "draft", subState: "queued" });
    expect(listEvents(db, task.id).at(-1)).toMatchObject({ payload: { command: "resume" } });
  });

  it("answers 409 outside needs_human and paused, and 404 if it does not exist", async () => {
    const { send, create } = setup();
    const task = await create();
    expect((await send("POST", `/api/tasks/${task.id}/resume`)).status).toBe(409);
    expect((await send("POST", `/api/tasks/${missing}/resume`)).status).toBe(404);
  });
});

describe("POST /api/tasks/:id/cancel", () => {
  it("cancels with an optional note and records the event", async () => {
    const { db, send, create } = setup();
    const task = await create();
    const res = await send("POST", `/api/tasks/${task.id}/cancel`, { note: "ya no aplica" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "cancelled", subState: null });
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      type: "task.transitioned",
      payload: { command: "cancel", note: "ya no aplica" },
    });
  });

  it("accepts an empty body", async () => {
    const { db, project } = setup();
    const task = insertTask(db, project.id);
    const res = await createApp({ db }).request(`/api/tasks/${task.id}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  it("answers 409 if already canceled, 404 if it does not exist and 400 with an invalid note", async () => {
    const { send, create } = setup();
    const task = await create();
    expect((await send("POST", `/api/tasks/${task.id}/cancel`, { note: "" })).status).toBe(400);
    await send("POST", `/api/tasks/${task.id}/cancel`);
    const res = await send("POST", `/api/tasks/${task.id}/cancel`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "invalid_transition" });
    expect((await send("POST", `/api/tasks/${missing}/cancel`)).status).toBe(404);
  });
});

describe("dependencies", () => {
  it("PUT adds the edge (201) and repeating it answers 200 without duplicating", async () => {
    const { send, create } = setup();
    const a = await create();
    const b = await create();
    expect((await send("PUT", `/api/tasks/${b.id}/dependencies/${a.id}`)).status).toBe(201);
    expect((await send("PUT", `/api/tasks/${b.id}/dependencies/${a.id}`)).status).toBe(200);
    const deps = (await (await send("GET", `/api/tasks/${b.id}/dependencies`)).json()) as {
      dependsOn: { taskId: string; crossProject: boolean }[];
      dependents: unknown[];
    };
    expect(deps.dependsOn).toMatchObject([{ taskId: a.id, crossProject: false }]);
    expect(deps.dependents).toEqual([]);
  });

  it("answers 409 cycle with the path if the edge closes a cycle", async () => {
    const { send, create } = setup();
    const a = await create();
    const b = await create({ dependsOn: [a.id] });
    const c = await create({ dependsOn: [b.id] });
    const res = await send("PUT", `/api/tasks/${a.id}/dependencies/${c.id}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "cycle", cycle: [a.id, c.id, b.id, a.id] });
    const self = await send("PUT", `/api/tasks/${a.id}/dependencies/${a.id}`);
    expect(await self.json()).toMatchObject({ error: "cycle", cycle: [a.id, a.id] });
  });

  it("answers 404 if the task does not exist and 422 if the dependency does not exist", async () => {
    const { send, create } = setup();
    const a = await create();
    expect((await send("PUT", `/api/tasks/${missing}/dependencies/${a.id}`)).status).toBe(404);
    const res = await send("PUT", `/api/tasks/${a.id}/dependencies/${missing}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "dependency_not_found" });
    expect((await send("GET", `/api/tasks/${missing}/dependencies`)).status).toBe(404);
  });

  it("answers 409 if the task is not in draft or the dependency is canceled", async () => {
    const { send, create } = setup();
    const a = await create();
    const b = await create();
    await send("POST", `/api/tasks/${a.id}/cancel`);
    const cancelled = await send("PUT", `/api/tasks/${b.id}/dependencies/${a.id}`);
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ error: "dependency_cancelled" });
    const notDraft = await send("PUT", `/api/tasks/${a.id}/dependencies/${b.id}`);
    expect(await notDraft.json()).toMatchObject({ error: "task_not_draft" });
  });

  it("each repository error answers with its HTTP code", async () => {
    const { send, create } = setup();
    const cancelled = await create();
    await send("POST", `/api/tasks/${cancelled.id}/cancel`);
    const a = await create();
    const b = await create({ dependsOn: [a.id] });
    const cases: [string, string, number, string][] = [
      ["PUT", `/api/tasks/${b.id}/dependencies/${cancelled.id}`, 409, "dependency_cancelled"],
      ["PUT", `/api/tasks/${a.id}/dependencies/${a.id}`, 409, "cycle"],
      ["PUT", `/api/tasks/${cancelled.id}/dependencies/${a.id}`, 409, "task_not_draft"],
      ["PUT", `/api/tasks/${a.id}/dependencies/${missing}`, 422, "dependency_not_found"],
      ["DELETE", `/api/tasks/${cancelled.id}/dependencies/${a.id}`, 409, "task_terminal"],
      ["PATCH", `/api/tasks/${cancelled.id}`, 409, "task_terminal"],
      ["POST", `/api/tasks/${cancelled.id}/cancel`, 409, "invalid_transition"],
    ];
    for (const [method, path, status, error] of cases) {
      const res = await send(method, path, method === "PATCH" ? { priority: 1 } : undefined);
      expect({ path, status: res.status, body: await res.json() }).toMatchObject({
        path,
        status,
        body: { error },
      });
    }
  });

  it("DELETE removes the edge (204) and answers 404 if it did not exist", async () => {
    const { send, create } = setup();
    const a = await create();
    const b = await create({ dependsOn: [a.id] });
    expect((await send("DELETE", `/api/tasks/${b.id}/dependencies/${a.id}`)).status).toBe(204);
    expect((await send("DELETE", `/api/tasks/${b.id}/dependencies/${a.id}`)).status).toBe(404);
  });
});
