import { EMPTY_USAGE } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { appendEvent } from "./event-log.ts";
import { RunSubagentRepository } from "./run-subagents.ts";
import { taskDependencies, usageRecords } from "./schema.ts";
import { TaskViewRepository } from "./task-views.ts";
import { insertProject, insertRun, insertTask, migratedDatabase } from "./test-helpers.ts";

function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const task = insertTask(db, project.id);
  return { db, project, task, views: new TaskViewRepository(db) };
}

function usage(
  db: ReturnType<typeof migratedDatabase>,
  runId: string,
  values: Partial<typeof usageRecords.$inferInsert> = {},
) {
  db.insert(usageRecords)
    .values({ runId, model: "opus", source: "otel", ...values })
    .run();
}

describe("TaskViewRepository.runs", () => {
  it("devuelve los Runs en orden de inicio y sin el run token", () => {
    const { db, task, views } = setup();
    const first = insertRun(db, task.id, {
      phase: "refine",
      startedAt: new Date("2026-10-01T10:00:00Z"),
      endedAt: new Date("2026-10-01T11:00:00Z"),
      result: "failure",
      failureReason: "timeout de fase",
    });
    const second = insertRun(db, task.id, {
      phase: "refine",
      startedAt: new Date("2026-10-01T12:00:00Z"),
      handoff: { ok: true },
    });
    const runs = views.runs(task.id);
    expect(runs?.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(runs?.[0]).toMatchObject({ result: "failure", failureReason: "timeout de fase" });
    expect(runs?.[1]).toMatchObject({ handoff: { ok: true }, endedAt: null });
    expect(runs?.[0]).not.toHaveProperty("runToken");
  });

  it("devuelve null si la tarea no existe", () => {
    const { views } = setup();
    expect(views.runs("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("TaskViewRepository.events", () => {
  it("devuelve el Event log de la tarea en orden de escritura", () => {
    const { db, task, views } = setup();
    appendEvent(db, { taskId: task.id, type: "a", actor: "human", payload: { n: 1 } });
    appendEvent(db, { taskId: task.id, type: "b", actor: "system" });
    expect(views.events(task.id)?.map((e) => [e.type, e.actor, e.payload])).toEqual([
      ["a", "human", { n: 1 }],
      ["b", "system", null],
    ]);
  });

  it("devuelve null si la tarea no existe", () => {
    const { views } = setup();
    expect(views.events("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("TaskViewRepository.usage", () => {
  it("suma los UsageRecords por Run y en total", () => {
    const { db, task, views } = setup();
    const refine = insertRun(db, task.id, { phase: "refine", endedAt: new Date() });
    const implement = insertRun(db, task.id, { phase: "implement" });
    usage(db, refine.id, { inputTokens: 10, outputTokens: 5, costUsd: 0.5, sourceRef: "1" });
    usage(db, refine.id, { inputTokens: 1, cacheReadTokens: 7, costUsd: 0.25, sourceRef: "2" });
    usage(db, implement.id, { outputTokens: 3, cacheWriteTokens: 2 });

    const result = views.usage(task.id);
    expect(result?.total).toEqual({
      inputTokens: 11,
      outputTokens: 8,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
      // El Run de implementación no trae costo: el total no se puede afirmar.
      costUsd: null,
    });
    expect(result?.byRun).toEqual([
      {
        runId: refine.id,
        phase: "refine",
        usage: {
          inputTokens: 11,
          outputTokens: 5,
          cacheReadTokens: 7,
          cacheWriteTokens: 0,
          costUsd: 0.75,
        },
      },
      {
        runId: implement.id,
        phase: "implement",
        usage: { ...EMPTY_USAGE, outputTokens: 3, cacheWriteTokens: 2 },
      },
    ]);
  });

  it("devuelve totales en cero sin UsageRecords", () => {
    const { task, views } = setup();
    expect(views.usage(task.id)).toEqual({
      total: EMPTY_USAGE,
      byRun: [],
      byPhase: [],
      byAgent: [],
      byModel: [],
      byReviewer: [],
    });
  });

  it("devuelve null si la tarea no existe", () => {
    const { views } = setup();
    expect(views.usage("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("deja el costo en null si algún registro no lo trae", () => {
    const { db, task, views } = setup();
    const run = insertRun(db, task.id, { endedAt: new Date() });
    usage(db, run.id, { costUsd: 2, sourceRef: "1" });
    usage(db, run.id, { inputTokens: 5, sourceRef: "2" });
    expect(views.usage(task.id)?.total).toEqual({ ...EMPTY_USAGE, inputTokens: 5 });
  });
});

describe("TaskViewRepository.usage: desgloses", () => {
  const tokens = (n: number) => ({ ...EMPTY_USAGE, inputTokens: n, costUsd: n / 10 });
  const rec = (n: number, extra: Partial<typeof usageRecords.$inferInsert> = {}) => ({
    inputTokens: n,
    costUsd: n / 10,
    sourceRef: `r${n}`,
    ...extra,
  });

  it("separa el rework de la implementación y agrupa por fase, agente y modelo", () => {
    const { db, task, views } = setup();
    const refine = insertRun(db, task.id, { phase: "refine", endedAt: new Date() });
    const first = insertRun(db, task.id, { phase: "implement", iteration: 0, endedAt: new Date() });
    const rework = insertRun(db, task.id, {
      phase: "implement",
      iteration: 1,
      endedAt: new Date(),
    });
    const verify = insertRun(db, task.id, { phase: "verify", iteration: 1 });
    usage(db, refine.id, rec(10, { model: "opus" }));
    usage(db, first.id, rec(20, { model: "sonnet" }));
    usage(db, first.id, rec(30, { model: "opus" }));
    usage(db, rework.id, rec(40, { model: "opus" }));
    usage(db, verify.id, rec(50, { model: "opus" }));

    const result = views.usage(task.id);
    expect(result?.byPhase).toEqual([
      { phase: "refine", usage: tokens(10) },
      { phase: "implement", usage: tokens(50) },
      { phase: "rework", usage: tokens(40) },
      { phase: "verify", usage: tokens(50) },
    ]);
    expect(result?.byAgent).toEqual([{ agentKind: "claude", usage: tokens(150) }]);
    expect(result?.byModel).toEqual([
      { model: "opus", usage: tokens(130) },
      { model: "sonnet", usage: tokens(20) },
    ]);
  });

  it("desglosa por revisor con los agent_id que registraron los hooks de subagentes", () => {
    const { db, task, views } = setup();
    const verify = insertRun(db, task.id, { phase: "verify" });
    const subagents = new RunSubagentRepository(db);
    subagents.recordStart(verify.id, { agentId: "a1", agentType: "lunasq-code-reviewer" });
    subagents.recordStart(verify.id, { agentId: "a2", agentType: "lunasq-security-reviewer" });
    subagents.recordStart(verify.id, { agentId: "a3", agentType: "Explore" });
    usage(db, verify.id, rec(1)); // sesión principal: el approver
    usage(db, verify.id, rec(2, { agentId: "a1" }));
    usage(db, verify.id, rec(3, { agentId: "a1" }));
    usage(db, verify.id, rec(4, { agentId: "a2" }));
    usage(db, verify.id, rec(5, { agentId: "a3" })); // subagente que no es revisor
    usage(db, verify.id, rec(6, { agentId: "a9" })); // hook perdido: no se sabe de quién es

    expect(views.usage(task.id)?.byReviewer).toEqual([
      { reviewer: "lunasq-code-reviewer", usage: tokens(5) },
      { reviewer: "lunasq-security-reviewer", usage: tokens(4) },
    ]);
    expect(views.usage(task.id)?.total.inputTokens).toBe(21);
  });

  it("deja el costo en null en el grupo que tiene un registro sin costo, y solo en ese", () => {
    const { db, task, views } = setup();
    const refine = insertRun(db, task.id, { phase: "refine", endedAt: new Date() });
    const verify = insertRun(db, task.id, { phase: "verify" });
    new RunSubagentRepository(db).recordStart(verify.id, {
      agentId: "a1",
      agentType: "lunasq-code-reviewer",
    });
    usage(db, refine.id, rec(10));
    usage(db, verify.id, rec(20, { agentId: "a1" }));
    usage(db, verify.id, { inputTokens: 5, sourceRef: "sin-costo", agentId: "a1" });

    const result = views.usage(task.id);
    expect(result?.byPhase.map((g) => [g.phase, g.usage.costUsd])).toEqual([
      ["refine", 1],
      ["verify", null],
    ]);
    expect(result?.byReviewer).toEqual([
      { reviewer: "lunasq-code-reviewer", usage: { ...tokens(25), costUsd: null } },
    ]);
  });

  it("el hook de otro Run no le atribuye consumo a este", () => {
    const { db, task, views } = setup();
    const other = insertRun(db, insertTask(db, insertProject(db).id).id, { phase: "verify" });
    const verify = insertRun(db, task.id, { phase: "verify" });
    new RunSubagentRepository(db).recordStart(other.id, {
      agentId: "a1",
      agentType: "lunasq-code-reviewer",
    });
    usage(db, verify.id, rec(2, { agentId: "a1" }));
    expect(views.usage(task.id)?.byReviewer).toEqual([]);
  });
});

describe("TaskViewRepository.usageByTask", () => {
  it("suma por tarea y omite las que no tienen consumo", () => {
    const { db, project, task, views } = setup();
    const other = insertTask(db, project.id);
    usage(db, insertRun(db, task.id, { endedAt: new Date() }).id, { inputTokens: 4, costUsd: 0.5 });
    usage(db, insertRun(db, task.id).id, { inputTokens: 6, costUsd: 1 });
    const totals = views.usageByTask();
    expect(totals.get(task.id)).toEqual({ ...EMPTY_USAGE, inputTokens: 10, costUsd: 1.5 });
    expect(totals.has(other.id)).toBe(false);
  });
});

describe("TaskViewRepository.changesSince", () => {
  it("devuelve el último id y las tareas con eventos posteriores, sin repetir", () => {
    const { db, project, task, views } = setup();
    const other = insertTask(db, project.id);
    expect(views.lastEventId()).toBe(0);
    const first = appendEvent(db, { taskId: task.id, type: "a", actor: "human" });
    appendEvent(db, { taskId: other.id, type: "b", actor: "system" });
    const last = appendEvent(db, { taskId: task.id, type: "c", actor: "system" });

    expect(views.lastEventId()).toBe(last.id);
    expect(views.changesSince(first.id - 1)).toEqual({
      lastId: last.id,
      taskIds: [task.id, other.id],
    });
    expect(views.changesSince(first.id)).toEqual({ lastId: last.id, taskIds: [other.id, task.id] });
    expect(views.changesSince(last.id)).toEqual({ lastId: last.id, taskIds: [] });
  });
});

describe("TaskViewRepository.graph", () => {
  const edge = (db: ReturnType<typeof migratedDatabase>, taskId: string, dependsOnId: string) =>
    db.insert(taskDependencies).values({ taskId, dependsOnId }).run();

  it("devuelve las tareas del proyecto, incluso sin aristas, y sus aristas reales", () => {
    const { db, project, task, views } = setup();
    const base = insertTask(db, project.id, { intent: "Base" });
    const isolated = insertTask(db, project.id, { intent: "Aislada" });
    edge(db, task.id, base.id);

    const graph = views.graph(project.id);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([base.id, isolated.id, task.id].sort());
    expect(graph.nodes.find((n) => n.id === base.id)).toEqual({
      id: base.id,
      projectId: project.id,
      intent: "Base",
      state: "draft",
      subState: "queued",
      prState: null,
      priority: 100,
    });
    expect(graph.edges).toEqual([{ taskId: task.id, dependsOnId: base.id }]);
  });

  it("un proyecto sin aristas devuelve sus tareas y ninguna arista", () => {
    const { project, task, views } = setup();
    expect(views.graph(project.id)).toMatchObject({ nodes: [{ id: task.id }], edges: [] });
  });

  it("incluye al otro extremo de una dependencia entre proyectos, pero no el resto del otro", () => {
    const { db, project, task, views } = setup();
    const other = insertProject(db);
    const upstream = insertTask(db, other.id, { intent: "Ajena con arista" });
    insertTask(db, other.id, { intent: "Ajena sin arista" });
    edge(db, task.id, upstream.id);

    const graph = views.graph(project.id);
    expect(graph.nodes.map((n) => n.intent).sort()).toEqual(["Ajena con arista", "Hacer algo"]);
    expect(graph.edges).toEqual([{ taskId: task.id, dependsOnId: upstream.id }]);
  });

  it("sin proyecto devuelve todas las tareas y aristas, y las aristas son dependencias reales", () => {
    const { db, project, task, views } = setup();
    const other = insertProject(db);
    const b = insertTask(db, other.id);
    edge(db, b.id, task.id);
    const graph = views.graph();
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([b.id, task.id].sort());
    expect(graph.edges).toEqual([{ taskId: b.id, dependsOnId: task.id }]);
    expect(views.graph(project.id).edges).toEqual([{ taskId: b.id, dependsOnId: task.id }]);
  });
});

describe("TaskViewRepository.hookExecutions", () => {
  const executed = (point: string, script: string, over: Record<string, unknown> = {}) => ({
    point,
    script,
    baseRef: "a".repeat(40),
    runId: null,
    policy: "block",
    timeoutSeconds: 600,
    exitCode: 0,
    timedOut: false,
    durationMs: 12,
    passed: true,
    output: "ok",
    ...over,
  });

  it("devuelve las ejecuciones del proyecto, las más nuevas primero, con la tarea", () => {
    const { db, project, task, views } = setup();
    const other = insertProject(db);
    const foreign = insertTask(db, other.id);
    const e1 = appendEvent(db, {
      taskId: task.id,
      type: "hook.executed",
      actor: "system",
      payload: executed("before_delivery", "10-bump"),
    });
    appendEvent(db, {
      taskId: task.id,
      type: "hook.point_completed",
      actor: "system",
      payload: {},
    });
    appendEvent(db, {
      taskId: foreign.id,
      type: "hook.executed",
      actor: "system",
      payload: executed("before_delivery", "10-bump"),
    });
    const e2 = appendEvent(db, {
      taskId: task.id,
      type: "hook.executed",
      actor: "system",
      payload: executed("after_merge", "deploy", { exitCode: 1, passed: false, output: "boom" }),
    });

    const rows = views.hookExecutions(project.id, 10);
    expect(rows.map((r) => r.eventId)).toEqual([e2.id, e1.id]);
    expect(rows[0]).toMatchObject({
      taskId: task.id,
      taskIntent: "Hacer algo",
      point: "after_merge",
      script: "deploy",
      exitCode: 1,
      passed: false,
      output: "boom",
    });
    expect(rows[0]?.at).toBeInstanceOf(Date);
  });

  it("deja la ejecución más reciente de cada tarea en cada script", () => {
    const { db, project, task, views } = setup();
    const other = insertTask(db, project.id, { intent: "Otra" });
    const add = (taskId: string, over: Record<string, unknown>) =>
      appendEvent(db, {
        taskId,
        type: "hook.executed",
        actor: "system",
        payload: executed("before_delivery", "10-bump", over),
      });
    add(task.id, { exitCode: 1, passed: false });
    const newest = add(task.id, { output: "segunda" });
    const o = add(other.id, {});

    const rows = views.hookExecutions(project.id, 10);
    expect(rows.map((r) => r.eventId)).toEqual([o.id, newest.id]);
    expect(rows[1]).toMatchObject({ output: "segunda", passed: true });
  });

  it("limita las tareas por punto y script sin que un hook desplace a otro", () => {
    const { db, project, views } = setup();
    const old = insertTask(db, project.id, { intent: "Vieja" });
    appendEvent(db, {
      taskId: old.id,
      type: "hook.executed",
      actor: "system",
      payload: executed("after_merge", "deploy"),
    });
    for (let i = 0; i < 5; i++) {
      const t = insertTask(db, project.id);
      appendEvent(db, {
        taskId: t.id,
        type: "hook.executed",
        actor: "system",
        payload: executed("before_delivery", "10-bump"),
      });
    }
    const rows = views.hookExecutions(project.id, 2);
    expect(rows.filter((r) => r.script === "10-bump")).toHaveLength(2);
    // after_merge es la ejecución más vieja del proyecto y sigue apareciendo.
    expect(rows.find((r) => r.script === "deploy")).toMatchObject({ taskId: old.id });
  });

  it("se salta payloads que no son de hook", () => {
    const { db, project, task, views } = setup();
    appendEvent(db, { taskId: task.id, type: "hook.executed", actor: "system", payload: { x: 1 } });
    expect(views.hookExecutions(project.id, 10)).toEqual([]);
  });
});
