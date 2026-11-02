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
  it("creates the project with defaults and answers 201", async () => {
    const { send } = setup();
    const project = await created(send);
    expect(project).toMatchObject({ ...input, limits: {}, testCommand: null, bootstrap: null });
    expect(project.agentProfiles).toMatchObject({ verify: { kind: "claude", args: [] } });
  });

  it("accepts Codex as a verification provider", async () => {
    const { send } = setup();
    const res = await send("POST", "/api/projects", {
      ...input,
      agentProfiles: { verify: { kind: "codex" } },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ agentProfiles: { verify: { kind: "codex" } } });
  });

  it("answers 400 if the body is not JSON", async () => {
    const { send } = setup();
    const res = await send("POST", "/api/projects", "{no json");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_json" });
  });

  it("answers 409 with the conflicting field", async () => {
    const { send } = setup();
    await created(send);
    const res = await send("POST", "/api/projects", { ...input, localPath: "/repos/otra" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", field: "name" });
  });
});

describe("GET /api/projects", () => {
  it("lists ordered by name", async () => {
    const { send } = setup();
    await created(send, { ...input, name: "zeta", localPath: "/repos/zeta" });
    await created(send, { ...input, name: "alfa", localPath: "/repos/alfa" });
    const res = await send("GET", "/api/projects");
    expect(res.status).toBe(200);
    const list = (await res.json()) as { name: string }[];
    expect(list.map((p) => p.name)).toEqual(["alfa", "zeta"]);
  });

  it("GET /:id returns the project or 404", async () => {
    const { send } = setup();
    const project = await created(send);
    const res = await send("GET", `/api/projects/${project.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(project);
    expect((await send("GET", `/api/projects/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe("PATCH /api/projects/:id", () => {
  it("updates the fields sent", async () => {
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

  it("accepts Codex as an updated verification provider", async () => {
    const { send } = setup();
    const project = await created(send);
    const res = await send("PATCH", `/api/projects/${project.id}`, {
      agentProfiles: { verify: { kind: "codex" } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agentProfiles: { verify: { kind: "codex" } } });
  });

  it("answers 404 if it does not exist", async () => {
    const { send } = setup();
    const res = await send("PATCH", `/api/projects/${crypto.randomUUID()}`, { baseBranch: "dev" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/projects/:id", () => {
  it("deletes and answers 204; the second time 404", async () => {
    const { send } = setup();
    const project = await created(send);
    expect((await send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    expect((await send("DELETE", `/api/projects/${project.id}`)).status).toBe(404);
  });

  it("answers 409 if the project has tasks", async () => {
    const { db, send } = setup();
    const project = await created(send);
    insertTask(db, project.id);
    const res = await send("DELETE", `/api/projects/${project.id}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "has_tasks" });
  });
});

describe("errors and per-phase PATCH", () => {
  it("answers 409 with localPath if the path already exists", async () => {
    const { send } = setup();
    await created(send);
    const res = await send("POST", "/api/projects", { ...input, name: "otro" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", field: "localPath" });
  });

  it("PATCH with a repeated name answers 409", async () => {
    const { send } = setup();
    await created(send);
    const other = await created(send, { ...input, name: "otro", localPath: "/repos/otro" });
    const res = await send("PATCH", `/api/projects/${other.id}`, { name: input.name });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", field: "name" });
  });

  it("PATCH of one phase keeps the others", async () => {
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

  it("an invalid row answers 500 in JSON", async () => {
    const { db, send } = setup();
    const row = insertProject(db, { agentProfiles: { verify: { kind: "gemini" } } });
    const res = await send("GET", `/api/projects/${row.id}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "invalid_row" });
  });
});
