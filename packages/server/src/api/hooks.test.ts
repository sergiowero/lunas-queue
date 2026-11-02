import { appendEvent } from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { HookError, type ProjectHooks } from "../hooks/index.ts";

const missing = "00000000-0000-4000-8000-000000000999";
const sha = "a".repeat(40);

const listing: ProjectHooks = {
  baseRef: sha,
  configError: null,
  points: [
    {
      point: "before_delivery",
      hooks: [
        {
          script: "10-bump",
          policy: "warn",
          timeoutSeconds: 300,
          content: "#!/bin/sh\necho bump\n",
        },
      ],
    },
  ],
};

function setup(hooks?: { listHooks(projectId: string): Promise<ProjectHooks> }) {
  const db = migratedDatabase();
  const project = insertProject(db);
  const app = createApp({ db, ...(hooks ? { hooks } : {}) });
  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return { db, project, get };
}

const executed = (script: string, over: Record<string, unknown> = {}) => ({
  point: "before_delivery",
  script,
  baseRef: sha,
  runId: null,
  policy: "warn",
  timeoutSeconds: 300,
  exitCode: 0,
  timedOut: false,
  durationMs: 40,
  passed: true,
  output: "listo",
  ...over,
});

describe("GET /api/projects/:id/hooks", () => {
  it("returns the hooks of the project's base branch", async () => {
    const { project, get } = setup({ listHooks: async () => listing });
    expect(await get(`/api/projects/${project.id}/hooks`)).toEqual({ status: 200, body: listing });
  });

  it("answers 404 if the project does not exist", async () => {
    const { get } = setup({
      listHooks: async (id) => {
        throw new HookError("project_not_found", `project ${id} does not exist`);
      },
    });
    expect((await get(`/api/projects/${missing}/hooks`)).status).toBe(404);
  });

  it("answers 502 if the base branch could not be read", async () => {
    const { project, get } = setup({
      listHooks: async () => {
        throw new Error("fetch failed");
      },
    });
    const res = await get(`/api/projects/${project.id}/hooks`);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "hooks_unavailable", message: "fetch failed" });
  });

  it("answers 503 without a hooks service", async () => {
    const { project, get } = setup();
    expect((await get(`/api/projects/${project.id}/hooks`)).status).toBe(503);
  });
});

describe("GET /api/projects/:id/hooks/executions", () => {
  it("lists the project's latest executions with their task and respects the per-hook limit", async () => {
    const { db, project, get } = setup();
    const task = insertTask(db, project.id, { intent: "Subir versión" });
    const second = insertTask(db, project.id, { intent: "Segunda" });
    for (const [t, script] of [
      [task.id, "10-a"],
      [second.id, "10-a"],
      [task.id, "20-b"],
    ] as const) {
      appendEvent(db, {
        taskId: t,
        type: "hook.executed",
        actor: "system",
        payload: executed(script, script === "20-b" ? { exitCode: 2, passed: false } : {}),
      });
    }
    const res = await get(`/api/projects/${project.id}/hooks/executions?limit=1`);
    expect(res.status).toBe(200);
    // One task per script: the most recent of 10-a is "Segunda".
    expect(res.body).toMatchObject([
      { taskId: task.id, taskIntent: "Subir versión", script: "20-b", exitCode: 2, passed: false },
      { taskId: second.id, script: "10-a", output: "listo", durationMs: 40 },
    ]);
  });

  it("does not mix executions of other projects", async () => {
    const { db, project, get } = setup();
    const foreign = insertTask(db, insertProject(db).id);
    appendEvent(db, {
      taskId: foreign.id,
      type: "hook.executed",
      actor: "system",
      payload: executed("10-a"),
    });
    expect((await get(`/api/projects/${project.id}/hooks/executions`)).body).toEqual([]);
  });

  it("answers 404 if the project does not exist and 400 with an invalid limit", async () => {
    const { project, get } = setup();
    expect((await get(`/api/projects/${missing}/hooks/executions`)).status).toBe(404);
    expect((await get(`/api/projects/${project.id}/hooks/executions?limit=0`)).status).toBe(400);
  });
});
