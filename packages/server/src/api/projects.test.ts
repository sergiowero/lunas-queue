import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const input = {
  name: "lunas-queue",
  repo: "sergiowero/lunas-queue",
  baseBranch: "main",
  localPath: "/repos/lunas-queue",
};

function setup() {
  const db = migratedDatabase();
  const app = createApp({ db });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  return { db, send };
}

async function created(send: ReturnType<typeof setup>["send"], body: object = input) {
  const res = await send("POST", "/api/projects", body);
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string } & Record<string, unknown>;
}

describe("POST /api/projects", () => {
  it("crea el proyecto con defaults y responde 201", async () => {
    const { send } = setup();
    const project = await created(send);
    expect(project).toMatchObject({ ...input, limits: {}, testCommand: null, bootstrap: null });
    expect(project.agentProfiles).toMatchObject({ verify: { kind: "claude", args: [] } });
  });

  it("responde 400 con issues si el perfil de verify no es claude", async () => {
    const { send } = setup();
    const res = await send("POST", "/api/projects", {
      ...input,
      agentProfiles: { verify: { kind: "codex" } },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: unknown[] }[] };
    expect(body).toMatchObject({ error: "invalid_input" });
    expect(body.issues[0]?.path).toEqual(["agentProfiles", "verify", "kind"]);
  });

  it("responde 400 si el cuerpo no es JSON", async () => {
    const { send } = setup();
    const res = await send("POST", "/api/projects", "{no json");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_json" });
  });

  it("responde 409 con el campo en conflicto", async () => {
    const { send } = setup();
    await created(send);
    const res = await send("POST", "/api/projects", { ...input, localPath: "/repos/otra" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", field: "name" });
  });
});

describe("GET /api/projects", () => {
  it("lista ordenado por nombre", async () => {
    const { send } = setup();
    await created(send, { ...input, name: "zeta", localPath: "/repos/zeta" });
    await created(send, { ...input, name: "alfa", localPath: "/repos/alfa" });
    const res = await send("GET", "/api/projects");
    expect(res.status).toBe(200);
    const list = (await res.json()) as { name: string }[];
    expect(list.map((p) => p.name)).toEqual(["alfa", "zeta"]);
  });

  it("GET /:id devuelve el proyecto o 404", async () => {
    const { send } = setup();
    const project = await created(send);
    const res = await send("GET", `/api/projects/${project.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(project);
    expect((await send("GET", `/api/projects/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe("PATCH /api/projects/:id", () => {
  it("actualiza los campos enviados", async () => {
    const { send } = setup();
    const project = await created(send);
    const res = await send("PATCH", `/api/projects/${project.id}`, {
      testCommand: "pnpm test",
      limits: { concurrency: 2 },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: input.name,
      testCommand: "pnpm test",
      limits: { concurrency: 2 },
    });
  });

  it("responde 400 si el perfil de verify no es claude", async () => {
    const { send } = setup();
    const project = await created(send);
    const res = await send("PATCH", `/api/projects/${project.id}`, {
      agentProfiles: { verify: { kind: "codex" } },
    });
    expect(res.status).toBe(400);
  });

  it("responde 404 si no existe", async () => {
    const { send } = setup();
    const res = await send("PATCH", `/api/projects/${crypto.randomUUID()}`, { baseBranch: "dev" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/projects/:id", () => {
  it("borra y responde 204; la segunda vez 404", async () => {
    const { send } = setup();
    const project = await created(send);
    expect((await send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    expect((await send("DELETE", `/api/projects/${project.id}`)).status).toBe(404);
  });

  it("responde 409 si el proyecto tiene tareas", async () => {
    const { db, send } = setup();
    const project = await created(send);
    insertTask(db, project.id);
    const res = await send("DELETE", `/api/projects/${project.id}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "has_tasks" });
  });
});

describe("errores y PATCH por fase", () => {
  it("responde 409 con localPath si la ruta ya existe", async () => {
    const { send } = setup();
    await created(send);
    const res = await send("POST", "/api/projects", { ...input, name: "otro" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", field: "localPath" });
  });

  it("PATCH con un nombre repetido responde 409", async () => {
    const { send } = setup();
    await created(send);
    const other = await created(send, { ...input, name: "otro", localPath: "/repos/otro" });
    const res = await send("PATCH", `/api/projects/${other.id}`, { name: input.name });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", field: "name" });
  });

  it("PATCH de una fase conserva las demás", async () => {
    const { send } = setup();
    const project = await created(send, {
      ...input,
      agentProfiles: { implement: { kind: "claude", model: "opus" } },
    });
    const res = await send("PATCH", `/api/projects/${project.id}`, {
      agentProfiles: { verify: { kind: "claude", model: "sonnet" } },
    });
    expect(await res.json()).toMatchObject({
      agentProfiles: { implement: { model: "opus" }, verify: { model: "sonnet" } },
    });
  });

  it("una fila inválida responde 500 en JSON", async () => {
    const { db, send } = setup();
    const row = insertProject(db, { agentProfiles: { verify: { kind: "codex" } } });
    const res = await send("GET", `/api/projects/${row.id}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "invalid_row" });
  });
});
