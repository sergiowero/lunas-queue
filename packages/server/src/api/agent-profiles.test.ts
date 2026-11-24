import { SettingsRepository } from "@lunasq/db";
import {
  allPhasesWith,
  insertAgentProfile,
  insertProject,
  insertTask,
  migratedDatabase,
} from "@lunasq/db/test-helpers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const fast = {
  name: "Fast",
  models: [
    { kind: "claude", model: "opus" },
    { kind: "codex", model: "gpt-5" },
  ],
};

function setup() {
  const db = migratedDatabase();
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
  return { db, send };
}

type Send = ReturnType<typeof setup>["send"];

async function created(send: Send, body: object = fast) {
  const res = await send("POST", "/api/agent-profiles", body);
  expect(res.status).toBe(201);
  return (await res.json()) as {
    id: string;
    name: string;
    models: { kind: string; model?: string; args: string[] }[];
  };
}

describe("POST /api/agent-profiles", () => {
  it("creates the profile with its models in order and answers 201", async () => {
    const { send } = setup();
    const profile = await created(send);
    expect(profile.name).toBe("Fast");
    expect(profile.models.map((m) => [m.kind, m.model])).toEqual([
      ["claude", "opus"],
      ["codex", "gpt-5"],
    ]);
    const list = (await (await send("GET", "/api/agent-profiles")).json()) as { id: string }[];
    expect(list.map((p) => p.id)).toEqual([profile.id]);
  });

  it("rejects a repeated name with 400 invalid_input and stores nothing more", async () => {
    const { send } = setup();
    await created(send);
    const res = await send("POST", "/api/agent-profiles", fast);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid_input",
      issues: [{ path: ["name"] }],
    });
    expect(((await (await send("GET", "/api/agent-profiles")).json()) as unknown[]).length).toBe(1);
  });

  it.each([
    ["0 models", { name: "Empty", models: [] }],
    [
      "more than 10 models",
      { name: "Big", models: Array.from({ length: 11 }, () => ({ kind: "claude" })) },
    ],
    ["an unknown provider", { name: "X", models: [{ kind: "gemini" }] }],
    ["an unknown field", { name: "X", models: [{ kind: "claude" }], extra: 1 }],
  ])("rejects %s with 400 invalid_input", async (_label, body) => {
    const { send } = setup();
    const res = await send("POST", "/api/agent-profiles", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
    expect(await (await send("GET", "/api/agent-profiles")).json()).toEqual([]);
  });

  it("rejects effort together with --effort in args, naming the flag", async () => {
    const { send } = setup();
    const res = await send("POST", "/api/agent-profiles", {
      name: "Bad",
      models: [{ kind: "claude", effort: "high", args: ["--effort", "low"] }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { message: string }[] };
    expect(body.issues[0]?.message).toContain("--effort");
    expect(await (await send("GET", "/api/agent-profiles")).json()).toEqual([]);
  });

  it("rejects a Copilot model with --autopilot in args, naming the flag", async () => {
    const { send } = setup();
    const res = await send("POST", "/api/agent-profiles", {
      name: "Bad",
      models: [{ kind: "claude" }, { kind: "copilot", args: ["--autopilot"] }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid_input",
      issues: [{ path: ["models", "1", "args"], message: expect.stringContaining("--autopilot") }],
    });
    expect(await (await send("GET", "/api/agent-profiles")).json()).toEqual([]);
  });

  it.each(["--auto", "--model=x", "--port", "--"])(
    "rejects an OpenCode model with %s in args with 400 invalid_input at [models, 1, args]",
    async (flag) => {
      const { send } = setup();
      const res = await send("POST", "/api/agent-profiles", {
        name: "Bad",
        models: [{ kind: "claude" }, { kind: "opencode", args: [flag] }],
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "invalid_input",
        issues: [{ path: ["models", "1", "args"], message: expect.stringContaining(flag) }],
      });
      expect(await (await send("GET", "/api/agent-profiles")).json()).toEqual([]);
    },
  );

  it("accepts an OpenCode model with its provider/model name and effort", async () => {
    const { send } = setup();
    const profile = await created(send, {
      name: "Open",
      models: [{ kind: "opencode", model: "anthropic/claude-sonnet-4", effort: "high" }],
    });
    expect(profile.models).toMatchObject([
      { kind: "opencode", model: "anthropic/claude-sonnet-4", effort: "high", args: [] },
    ]);
  });

  it("answers 400 if the body is not JSON", async () => {
    const { send } = setup();
    const res = await send("POST", "/api/agent-profiles", "{no");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });
});

describe("GET, PATCH and DELETE /api/agent-profiles/:id", () => {
  it("reads one profile and answers 404 for a missing one", async () => {
    const { send } = setup();
    const profile = await created(send);
    expect(
      ((await (await send("GET", `/api/agent-profiles/${profile.id}`)).json()) as { name: string })
        .name,
    ).toBe("Fast");
    expect((await send("GET", `/api/agent-profiles/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it("PATCH renames and reorders the models; the reserved flags are checked too", async () => {
    const { send } = setup();
    const profile = await created(send);
    const res = await send("PATCH", `/api/agent-profiles/${profile.id}`, {
      name: "Reordered",
      models: [fast.models[1], fast.models[0]],
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { name: string; models: { kind: string }[] };
    expect([updated.name, updated.models.map((m) => m.kind)]).toEqual([
      "Reordered",
      ["codex", "claude"],
    ]);
    const bad = await send("PATCH", `/api/agent-profiles/${profile.id}`, {
      models: [{ kind: "codex", args: ["--sandbox", "read-only"] }],
    });
    expect(bad.status).toBe(400);
    expect(
      (
        (await (await send("GET", `/api/agent-profiles/${profile.id}`)).json()) as {
          models: unknown[];
        }
      ).models,
    ).toHaveLength(2);
    expect(
      (await send("PATCH", `/api/agent-profiles/${crypto.randomUUID()}`, { name: "x" })).status,
    ).toBe(404);
  });

  it("DELETE removes an unused profile with 204; the second time 404", async () => {
    const { send } = setup();
    const profile = await created(send);
    expect((await send("DELETE", `/api/agent-profiles/${profile.id}`)).status).toBe(204);
    expect((await send("DELETE", `/api/agent-profiles/${profile.id}`)).status).toBe(404);
  });

  it("DELETE of a profile in use answers 409 profile_in_use listing the projects and phases", async () => {
    const { db, send } = setup();
    const profile = await created(send);
    const project = insertProject(db, {
      name: "proyecto-a",
      agentProfiles: { refine: null, implement: profile.id, verify: null, deliver: null },
    });

    const res = await send("DELETE", `/api/agent-profiles/${profile.id}`);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "profile_in_use",
      projects: [{ id: project.id, name: "proyecto-a", phases: ["implement"] }],
    });
    expect((await send("GET", `/api/agent-profiles/${profile.id}`)).status).toBe(200);
  });
});

describe("local origin guard", () => {
  it("rejects a Host that is not local with 403 forbidden_origin", async () => {
    const { send } = setup();
    for (const [method, path] of [
      ["GET", "/api/agent-profiles"],
      ["POST", "/api/agent-profiles"],
    ] as const) {
      const res = await send(method, path, method === "POST" ? fast : undefined, {
        host: "evil.example.com",
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden_origin" });
    }
    const origin = await send("GET", "/api/agent-profiles", undefined, {
      origin: "https://evil.example.com",
    });
    expect(origin.status).toBe(403);
  });
});

describe("GET /api/tasks/:id/hold", () => {
  it("explains why a queued task is held: the phase has no profile, naming the project and phase", async () => {
    const { db, send } = setup();
    const project = insertProject(db, {
      name: "sin-perfil",
      agentProfiles: { refine: null, implement: null, verify: null, deliver: null },
    });
    const task = insertTask(db, project.id);

    const res = await send("GET", `/api/tasks/${task.id}/hold`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      hold: {
        reason: "profile_missing",
        phase: "refine",
        projectId: project.id,
        projectName: "sin-perfil",
      },
    });
  });

  it("is null for a task that is not held and 404 for a missing one", async () => {
    const { db, send } = setup();
    const task = insertTask(db, insertProject(db).id);
    expect(await (await send("GET", `/api/tasks/${task.id}/hold`)).json()).toEqual({ hold: null });
    expect((await send("GET", `/api/tasks/${crypto.randomUUID()}/hold`)).status).toBe(404);
  });

  it("every model of the profile belongs to a disabled provider: held as providers_disabled", async () => {
    const { db, send } = setup();
    const profile = insertAgentProfile(db, { models: [{ kind: "copilot" }] });
    const project = insertProject(db, { agentProfiles: allPhasesWith(profile.id) });
    const task = insertTask(db, project.id);
    new SettingsRepository(db).saveProviders({ copilot: false });

    const res = await send("GET", `/api/tasks/${task.id}/hold`);

    expect(await res.json()).toMatchObject({
      hold: { reason: "providers_disabled", phase: "refine" },
    });
  });
});
