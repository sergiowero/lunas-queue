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
  it("devuelve los hooks de la rama base del proyecto", async () => {
    const { project, get } = setup({ listHooks: async () => listing });
    expect(await get(`/api/projects/${project.id}/hooks`)).toEqual({ status: 200, body: listing });
  });

  it("responde 404 si el proyecto no existe", async () => {
    const { get } = setup({
      listHooks: async (id) => {
        throw new HookError("project_not_found", `proyecto ${id} no existe`);
      },
    });
    expect((await get(`/api/projects/${missing}/hooks`)).status).toBe(404);
  });

  it("responde 502 si no se pudo leer la rama base", async () => {
    const { project, get } = setup({
      listHooks: async () => {
        throw new Error("fetch falló");
      },
    });
    const res = await get(`/api/projects/${project.id}/hooks`);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "hooks_unavailable", message: "fetch falló" });
  });

  it("responde 503 sin servicio de hooks", async () => {
    const { project, get } = setup();
    expect((await get(`/api/projects/${project.id}/hooks`)).status).toBe(503);
  });
});

describe("GET /api/projects/:id/hooks/executions", () => {
  it("lista las últimas ejecuciones del proyecto con su tarea y respeta el límite por hook", async () => {
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
    // Una tarea por script: la más reciente de 10-a es "Segunda".
    expect(res.body).toMatchObject([
      { taskId: task.id, taskIntent: "Subir versión", script: "20-b", exitCode: 2, passed: false },
      { taskId: second.id, script: "10-a", output: "listo", durationMs: 40 },
    ]);
  });

  it("no mezcla ejecuciones de otros proyectos", async () => {
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

  it("responde 404 si el proyecto no existe y 400 con un límite inválido", async () => {
    const { project, get } = setup();
    expect((await get(`/api/projects/${missing}/hooks/executions`)).status).toBe(404);
    expect((await get(`/api/projects/${project.id}/hooks/executions?limit=0`)).status).toBe(400);
  });
});
