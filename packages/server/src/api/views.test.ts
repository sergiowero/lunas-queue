import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGit } from "@lunasq/adapters";
import { appendEvent, taskDependencies, usageRecords } from "@lunasq/db";
import {
  insertProject,
  insertRun,
  insertTask,
  migratedDatabase,
  setTaskPosition,
} from "@lunasq/db/test-helpers";
import { EMPTY_USAGE } from "@lunasq/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const missing = "00000000-0000-4000-8000-000000000999";
const now = new Date("2026-10-29T12:00:00Z");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const git = new FakeGit();
  const app = createApp({ db, git, now: () => now });
  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return { db, project, git, get };
}

type Entry = { task: { id: string }; ready: boolean; score: number | null; usage: unknown };

describe("número de tarea en las vistas", () => {
  it("la cola, el DAG y las dependencias traen el número de cada tarea", async () => {
    const { db, project, get } = setup();
    const base = insertTask(db, project.id, { intent: "Base" });
    const task = insertTask(db, project.id, { intent: "Depende" });
    db.insert(taskDependencies).values({ taskId: task.id, dependsOnId: base.id }).run();

    const queue = (await get("/api/queue")).body as { task: { id: string; number: number } }[];
    expect(queue.map((e) => [e.task.id, e.task.number]).sort()).toEqual(
      [
        [base.id, base.number],
        [task.id, task.number],
      ].sort(),
    );
    const graph = (await get("/api/graph")).body as { nodes: { id: string; number: number }[] };
    expect(graph.nodes.map((n) => [n.id, n.number])).toEqual([
      [base.id, base.number],
      [task.id, task.number],
    ]);
    const deps = (await get(`/api/tasks/${task.id}/dependencies`)).body as {
      dependsOn: { taskId: string; number: number }[];
    };
    expect(deps.dependsOn).toMatchObject([{ taskId: base.id, number: base.number }]);
  });
});

describe("GET /api/queue", () => {
  it("pone primero el ready set en el orden del scheduler y después las demás vivas", async () => {
    const { db, project, get } = setup();
    const created = new Date("2026-10-29T10:00:00Z");
    const low = insertTask(db, project.id, { priority: 10, createdAt: created });
    const high = insertTask(db, project.id, { priority: 50, createdAt: created });
    const running = insertTask(db, project.id, { priority: 999, createdAt: created });
    setTaskPosition(db, running.id, { state: "draft", subState: "running" });
    const done = insertTask(db, project.id, { priority: 999 });
    setTaskPosition(db, done.id, { state: "completed", subState: null });

    const { status, body } = await get("/api/queue");
    expect(status).toBe(200);
    const entries = body as Entry[];
    expect(entries.map((e) => [e.task.id, e.ready])).toEqual([
      [high.id, true],
      [low.id, true],
      [running.id, false],
    ]);
    // score = prioridad + 10 puntos/hora de aging (2 h desde la creación).
    expect(entries[0]).toMatchObject({ score: 70, effectivePriority: 50 });
    expect(entries[2]).toMatchObject({ score: null, effectivePriority: null });
  });

  it("hereda la prioridad de lo que bloquea y suma el boost", async () => {
    const { db, project, get } = setup();
    const created = new Date("2026-10-29T12:00:00Z");
    const base = insertTask(db, project.id, { priority: 1, createdAt: created });
    const blocked = insertTask(db, project.id, { priority: 80, createdAt: created });
    db.insert(taskDependencies).values({ taskId: blocked.id, dependsOnId: base.id }).run();
    const entries = (await get("/api/queue")).body as Entry[];
    expect(entries.map((e) => [e.task.id, e.ready, e.score])).toEqual([
      [base.id, true, 105],
      [blocked.id, false, null],
    ]);
  });

  it("filtra por proyecto e incluye el usage de cada tarea", async () => {
    const { db, project, get } = setup();
    const other = insertProject(db);
    const mine = insertTask(db, project.id);
    insertTask(db, other.id);
    const run = insertRun(db, mine.id, { endedAt: now });
    db.insert(usageRecords)
      .values({ runId: run.id, model: "opus", source: "otel", inputTokens: 9 })
      .run();

    const entries = (await get(`/api/queue?projectId=${project.id}`)).body as Entry[];
    expect(entries.map((e) => e.task.id)).toEqual([mine.id]);
    expect(entries[0]?.usage).toEqual({ ...EMPTY_USAGE, inputTokens: 9 });
  });

  it("responde 400 con un projectId inválido", async () => {
    const { get } = setup();
    expect((await get("/api/queue?projectId=x")).status).toBe(400);
  });
});

describe("GET /api/tasks/:id/runs", () => {
  it("lista los Runs sin el run token", async () => {
    const { db, project, get } = setup();
    const task = insertTask(db, project.id);
    insertRun(db, task.id, {
      phase: "refine",
      failureReason: "timeout",
      result: "failure",
      endedAt: now,
    });
    const { status, body } = await get(`/api/tasks/${task.id}/runs`);
    expect(status).toBe(200);
    expect(body).toEqual([
      expect.objectContaining({ phase: "refine", result: "failure", failureReason: "timeout" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("token-");
  });

  it("responde 404 si la tarea no existe", async () => {
    const { get } = setup();
    expect((await get(`/api/tasks/${missing}/runs`)).status).toBe(404);
  });
});

describe("GET /api/tasks/:id/events", () => {
  it("devuelve el Event log en orden", async () => {
    const { db, project, get } = setup();
    const task = insertTask(db, project.id);
    appendEvent(db, { taskId: task.id, type: "task.created", actor: "human" });
    appendEvent(db, {
      taskId: task.id,
      type: "task.transitioned",
      actor: "system",
      payload: { to: "refined" },
    });
    const { body } = await get(`/api/tasks/${task.id}/events`);
    expect((body as { type: string }[]).map((e) => e.type)).toEqual([
      "task.created",
      "task.transitioned",
    ]);
  });

  it("responde 404 si la tarea no existe", async () => {
    const { get } = setup();
    expect((await get(`/api/tasks/${missing}/events`)).status).toBe(404);
  });
});

describe("GET /api/tasks/:id/usage", () => {
  it("devuelve el total y el desglose por Run", async () => {
    const { db, project, get } = setup();
    const task = insertTask(db, project.id);
    const run = insertRun(db, task.id, { phase: "refine", endedAt: now });
    db.insert(usageRecords)
      .values({ runId: run.id, model: "opus", source: "otel", outputTokens: 4 })
      .run();
    const { body } = await get(`/api/tasks/${task.id}/usage`);
    expect(body).toEqual({
      total: { ...EMPTY_USAGE, outputTokens: 4 },
      byRun: [{ runId: run.id, phase: "refine", usage: { ...EMPTY_USAGE, outputTokens: 4 } }],
      byPhase: [{ phase: "refine", usage: { ...EMPTY_USAGE, outputTokens: 4 } }],
      byAgent: [{ agentKind: "claude", usage: { ...EMPTY_USAGE, outputTokens: 4 } }],
      byModel: [{ model: "opus", usage: { ...EMPTY_USAGE, outputTokens: 4 } }],
      byReviewer: [],
    });
  });

  it("responde 404 si la tarea no existe", async () => {
    const { get } = setup();
    expect((await get(`/api/tasks/${missing}/usage`)).status).toBe(404);
  });
});

describe("GET /api/tasks/:id/evidence", () => {
  it("lee lunasq/tasks/{id}.md del worktree", async () => {
    const { db, project, get } = setup();
    const worktree = mkdtempSync(join(tmpdir(), "lunasq-evidence-"));
    dirs.push(worktree);
    const task = insertTask(db, project.id, { worktreePath: worktree });
    mkdirSync(join(worktree, "lunasq", "tasks"), { recursive: true });
    const path = join(worktree, "lunasq", "tasks", `${task.id}.md`);
    writeFileSync(path, "# Evidencia\n");
    expect(await get(`/api/tasks/${task.id}/evidence`)).toEqual({
      status: 200,
      body: { source: "worktree", path, markdown: "# Evidencia\n" },
    });
  });

  it("sin worktree la lee de la branch de la tarea en el repo del proyecto", async () => {
    const { db, project, git, get } = setup();
    const task = insertTask(db, project.id, { branch: "lunasq/login" });
    const file = `lunasq/tasks/${task.id}.md`;
    git.addCheckout(project.localPath, { branch: "main", tree: {} });
    git.pushToRemote(project.localPath, "lunasq/login", { [file]: { content: "# En la branch" } });
    await git.fetch({ cwd: project.localPath, remote: "origin", branch: "lunasq/login" });
    expect(await get(`/api/tasks/${task.id}/evidence`)).toEqual({
      status: 200,
      body: { source: "branch", path: `origin/lunasq/login:${file}`, markdown: "# En la branch" },
    });
  });

  it("tras el merge, con la branch borrada, la lee de la rama base", async () => {
    const { db, project, git, get } = setup();
    const task = insertTask(db, project.id, { branch: "lunasq/borrada", prState: "merged" });
    const file = `lunasq/tasks/${task.id}.md`;
    git.addCheckout(project.localPath, {
      branch: "main",
      tree: { [file]: { content: "# Mergeada" } },
    });
    expect(await get(`/api/tasks/${task.id}/evidence`)).toEqual({
      status: 200,
      body: { source: "base", path: `origin/main:${file}`, markdown: "# Mergeada" },
    });
  });

  it("un repo inaccesible cuenta como evidencia faltante", async () => {
    const { db, project, get } = setup();
    const task = insertTask(db, project.id, { branch: "lunasq/x" });
    expect(await get(`/api/tasks/${task.id}/evidence`)).toEqual({
      status: 404,
      body: { error: "evidence_not_found" },
    });
  });

  it("responde 404 sin worktree o sin archivo", async () => {
    const { db, project, get } = setup();
    const bare = insertTask(db, project.id);
    expect((await get(`/api/tasks/${bare.id}/evidence`)).status).toBe(404);
    const worktree = mkdtempSync(join(tmpdir(), "lunasq-evidence-"));
    dirs.push(worktree);
    const task = insertTask(db, project.id, { worktreePath: worktree });
    expect(await get(`/api/tasks/${task.id}/evidence`)).toEqual({
      status: 404,
      body: { error: "evidence_not_found" },
    });
    expect((await get(`/api/tasks/${missing}/evidence`)).body).toEqual({ error: "not_found" });
  });
});

describe("GET /api/graph", () => {
  it("devuelve las aristas reales y filtra por proyecto", async () => {
    const { db, project, get } = setup();
    const other = insertProject(db);
    const a = insertTask(db, project.id, { intent: "A" });
    const b = insertTask(db, project.id, { intent: "B" });
    const foreign = insertTask(db, other.id, { intent: "Ajena" });
    db.insert(taskDependencies).values({ taskId: b.id, dependsOnId: a.id }).run();
    db.insert(taskDependencies).values({ taskId: foreign.id, dependsOnId: b.id }).run();

    const all = (await get("/api/graph")).body as {
      nodes: { id: string }[];
      edges: unknown[];
    };
    expect(all.nodes).toHaveLength(3);
    expect(all.edges).toEqual([
      { taskId: b.id, dependsOnId: a.id },
      { taskId: foreign.id, dependsOnId: b.id },
    ]);

    const scoped = (await get(`/api/graph?projectId=${project.id}`)).body as typeof all;
    expect(scoped.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id, foreign.id].sort());
    expect(scoped.edges).toHaveLength(2);
  });

  it("rechaza un projectId inválido", async () => {
    const { get } = setup();
    expect((await get("/api/graph?projectId=nope")).status).toBe(400);
  });
});
