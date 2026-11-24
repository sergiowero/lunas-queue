import {
  insertAgentProfile,
  insertProject,
  insertTask,
  migratedDatabase,
} from "@lunasq/db/test-helpers";
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
    // Phases are unassigned until the human selects an agent profile.
    expect(project.agentProfiles).toEqual({
      refine: null,
      implement: null,
      verify: null,
      deliver: null,
    });
  });

  it("stores the selected profile ids per phase", async () => {
    const { db, send } = setup();
    const profile = insertAgentProfile(db);
    const res = await send("POST", "/api/projects", {
      ...input,
      agentProfiles: { verify: profile.id },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ agentProfiles: { verify: profile.id } });
  });

  it("rejects a phase that references a profile that does not exist with 400 profile_not_found", async () => {
    const { send } = setup();
    const res = await send("POST", "/api/projects", {
      ...input,
      agentProfiles: { implement: crypto.randomUUID() },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "profile_not_found", phases: ["implement"] });
    expect((await (await send("GET", "/api/projects")).json()) as unknown[]).toEqual([]);
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

  it("selects a profile for a phase and unassigns it with null", async () => {
    const { db, send } = setup();
    const profile = insertAgentProfile(db);
    const project = await created(send);
    const res = await send("PATCH", `/api/projects/${project.id}`, {
      agentProfiles: { verify: profile.id },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agentProfiles: { verify: profile.id } });
    const cleared = await send("PATCH", `/api/projects/${project.id}`, {
      agentProfiles: { verify: null },
    });
    expect(await cleared.json()).toMatchObject({ agentProfiles: { verify: null } });
  });

  it("a PATCH with an unknown profile id answers 400 profile_not_found and the project does not change", async () => {
    const { send } = setup();
    const project = await created(send);
    const res = await send("PATCH", `/api/projects/${project.id}`, {
      baseBranch: "develop",
      agentProfiles: { refine: crypto.randomUUID() },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "profile_not_found", phases: ["refine"] });
    const stored = (await (await send("GET", `/api/projects/${project.id}`)).json()) as {
      baseBranch: string;
    };
    expect(stored.baseBranch).toBe("main");
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
    const { db, send } = setup();
    const opus = insertAgentProfile(db);
    const sonnet = insertAgentProfile(db);
    const project = await created(send, { ...input, agentProfiles: { implement: opus.id } });
    const res = await send("PATCH", `/api/projects/${project.id}`, {
      agentProfiles: { verify: sonnet.id },
    });
    expect(await res.json()).toMatchObject({
      agentProfiles: { implement: opus.id, verify: sonnet.id },
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

describe("project icon and color over HTTP", () => {
  it("POST stores and returns the icon and the color", async () => {
    const { send } = setup();
    const project = await created(send, { ...input, icon: "rocket", color: "teal" });
    expect(project).toMatchObject({ icon: "rocket", color: "teal" });
    const res = await send("GET", `/api/projects/${project.id}`);
    expect(await res.json()).toMatchObject({ icon: "rocket", color: "teal" });
  });

  it("POST without icon or color answers null in both", async () => {
    const { send } = setup();
    expect(await created(send)).toMatchObject({ icon: null, color: null });
  });

  it.each([
    ["icon", { icon: "unicorn" }],
    ["color", { color: "#ff0000" }],
  ])(
    "POST with a %s outside its set answers 400 with that path and stores nothing",
    async (path, extra) => {
      const { send } = setup();
      const res = await send("POST", "/api/projects", { ...input, ...extra });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues: { path: (string | number)[] }[] };
      expect(body.issues.map((i) => i.path[0])).toContain(path);
      const list = await send("GET", "/api/projects");
      expect(await list.json()).toEqual([]);
    },
  );

  it.each([
    ["icon", { icon: "unicorn" }],
    ["color", { color: "#ff0000" }],
  ])(
    "PATCH with a %s outside its set answers 400 with that path and changes nothing",
    async (path, extra) => {
      const { send } = setup();
      const project = await created(send, { ...input, icon: "rocket", color: "teal" });
      const res = await send("PATCH", `/api/projects/${project.id}`, extra);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues: { path: (string | number)[] }[] };
      expect(body.issues.map((i) => i.path[0])).toContain(path);
      const after = await send("GET", `/api/projects/${project.id}`);
      expect(await after.json()).toMatchObject({ icon: "rocket", color: "teal" });
    },
  );

  it("PATCH with color null clears the color and leaves the icon", async () => {
    const { send } = setup();
    const project = await created(send, { ...input, icon: "rocket", color: "teal" });
    const res = await send("PATCH", `/api/projects/${project.id}`, { color: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ icon: "rocket", color: null });
  });

  it("PATCH with only an icon leaves the color unchanged", async () => {
    const { send } = setup();
    const project = await created(send, { ...input, color: "blue" });
    const res = await send("PATCH", `/api/projects/${project.id}`, { icon: "database" });
    expect(await res.json()).toMatchObject({ icon: "database", color: "blue" });
  });
});
