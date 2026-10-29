import { listEvents } from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const missing = "00000000-0000-4000-8000-000000000999";

type TaskBody = { id: string; state: string; priority: number } & Record<string, unknown>;

function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const app = createApp({ db });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const create = async (overrides: object = {}): Promise<TaskBody> => {
    const res = await send("POST", "/api/tasks", {
      projectId: project.id,
      intent: "Hacer algo",
      priority: 100,
      ...overrides,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as TaskBody;
  };
  return { db, project, send, create };
}

describe("POST /api/tasks", () => {
  it("crea la tarea en draft y responde 201", async () => {
    const { create, project } = setup();
    const task = await create({ tags: ["auth"] });
    expect(task).toMatchObject({
      projectId: project.id,
      intent: "Hacer algo",
      tags: ["auth"],
      priority: 100,
      state: "draft",
      subState: "queued",
    });
  });

  it("responde 400 con JSON inválido o entrada inválida", async () => {
    const { send, project } = setup();
    expect((await send("POST", "/api/tasks", "{")).status).toBe(400);
    const res = await send("POST", "/api/tasks", {
      projectId: project.id,
      intent: "x",
      priority: -1,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string[] }[] };
    expect(body.error).toBe("invalid_input");
    expect(body.issues[0]?.path).toEqual(["priority"]);
  });

  it.each([
    ["project_not_found", { projectId: missing }],
    ["dependency_not_found", { dependsOn: [missing] }],
    ["caused_by_not_found", { causedBy: missing }],
  ])("responde 422 %s si una referencia no existe", async (code, overrides) => {
    const { send, project } = setup();
    const res = await send("POST", "/api/tasks", {
      projectId: project.id,
      intent: "Hacer algo",
      priority: 100,
      ...overrides,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: code });
  });
});

describe("GET /api/tasks", () => {
  it("lista ordenado por prioridad y filtra por proyecto y estado", async () => {
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

  it("responde 400 con un filtro inválido", async () => {
    const { send } = setup();
    expect((await send("GET", "/api/tasks?state=nuevo")).status).toBe(400);
    expect((await send("GET", "/api/tasks?projectId=p1")).status).toBe(400);
  });
});

describe("GET y PATCH /api/tasks/:id", () => {
  it("devuelve la tarea o 404", async () => {
    const { send, create } = setup();
    const task = await create();
    expect(await (await send("GET", `/api/tasks/${task.id}`)).json()).toMatchObject({
      id: task.id,
    });
    expect((await send("GET", `/api/tasks/${missing}`)).status).toBe(404);
  });

  it("actualiza intent, tags y prioridad", async () => {
    const { send, create } = setup();
    const task = await create();
    const res = await send("PATCH", `/api/tasks/${task.id}`, { priority: 900, tags: ["ui"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ priority: 900, tags: ["ui"] });
  });

  it("responde 400 si intenta cambiar el estado, 404 si no existe y 409 si es terminal", async () => {
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

describe("POST /api/tasks/:id/cancel", () => {
  it("cancela con nota opcional y registra el evento", async () => {
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

  it("acepta un cuerpo vacío", async () => {
    const { db, project } = setup();
    const task = insertTask(db, project.id);
    const res = await createApp({ db }).request(`/api/tasks/${task.id}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  it("responde 409 si ya está cancelada, 404 si no existe y 400 con nota inválida", async () => {
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

describe("dependencias", () => {
  it("PUT agrega la arista (201) y repetirla responde 200 sin duplicar", async () => {
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

  it("responde 409 cycle con el camino si la arista cierra un ciclo", async () => {
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

  it("responde 404 si la tarea no existe y 422 si la dependencia no existe", async () => {
    const { send, create } = setup();
    const a = await create();
    expect((await send("PUT", `/api/tasks/${missing}/dependencies/${a.id}`)).status).toBe(404);
    const res = await send("PUT", `/api/tasks/${a.id}/dependencies/${missing}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "dependency_not_found" });
    expect((await send("GET", `/api/tasks/${missing}/dependencies`)).status).toBe(404);
  });

  it("responde 409 si la tarea no está en draft o la dependencia está cancelada", async () => {
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

  it("cada error del repositorio responde con su código HTTP", async () => {
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

  it("DELETE quita la arista (204) y responde 404 si no existía", async () => {
    const { send, create } = setup();
    const a = await create();
    const b = await create({ dependsOn: [a.id] });
    expect((await send("DELETE", `/api/tasks/${b.id}/dependencies/${a.id}`)).status).toBe(204);
    expect((await send("DELETE", `/api/tasks/${b.id}/dependencies/${a.id}`)).status).toBe(404);
  });
});
