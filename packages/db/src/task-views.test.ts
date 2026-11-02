import { EMPTY_USAGE } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { appendEvent } from "./event-log.ts";
import { RunSubagentRepository } from "./run-subagents.ts";
import { usageRecords } from "./schema.ts";
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
  it("returns the Runs in start order and without the run token", () => {
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

  it("returns null if the task does not exist", () => {
    const { views } = setup();
    expect(views.runs("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("TaskViewRepository.events", () => {
  it("returns the task's Event log in write order", () => {
    const { db, task, views } = setup();
    appendEvent(db, { taskId: task.id, type: "a", actor: "human", payload: { n: 1 } });
    appendEvent(db, { taskId: task.id, type: "b", actor: "system" });
    expect(views.events(task.id)?.map((e) => [e.type, e.actor, e.payload])).toEqual([
      ["a", "human", { n: 1 }],
      ["b", "system", null],
    ]);
  });

  it("returns null if the task does not exist", () => {
    const { views } = setup();
    expect(views.events("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("TaskViewRepository.usage", () => {
  it("sums the UsageRecords per Run and in total", () => {
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
      // The implementation Run brings no cost: the total cannot be asserted.
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

  it("returns zero totals without UsageRecords", () => {
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

  it("returns null if the task does not exist", () => {
    const { views } = setup();
    expect(views.usage("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("leaves the cost as null if any record does not bring it", () => {
    const { db, task, views } = setup();
    const run = insertRun(db, task.id, { endedAt: new Date() });
    usage(db, run.id, { costUsd: 2, sourceRef: "1" });
    usage(db, run.id, { inputTokens: 5, sourceRef: "2" });
    expect(views.usage(task.id)?.total).toEqual({ ...EMPTY_USAGE, inputTokens: 5 });
  });
});

describe("TaskViewRepository.usage: breakdowns", () => {
  const tokens = (n: number) => ({ ...EMPTY_USAGE, inputTokens: n, costUsd: n / 10 });
  const rec = (n: number, extra: Partial<typeof usageRecords.$inferInsert> = {}) => ({
    inputTokens: n,
    costUsd: n / 10,
    sourceRef: `r${n}`,
    ...extra,
  });

  it("separates rework from implementation and groups by phase, agent and model", () => {
    const { db, task, views } = setup();
    const refine = insertRun(db, task.id, { phase: "refine", endedAt: new Date() });
    const first = insertRun(db, task.id, { phase: "implement", iteration: 0, endedAt: new Date() });
    const rework = insertRun(db, task.id, {
      phase: "implement",
      iteration: 1,
      endedAt: new Date(),
    });
    const verify = insertRun(db, task.id, {
      phase: "verify",
      iteration: 1,
      agentKind: "copilot",
    });
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
    expect(result?.byAgent).toEqual([
      { agentKind: "claude", usage: tokens(100) },
      { agentKind: "copilot", usage: tokens(50) },
    ]);
    expect(result?.byModel).toEqual([
      { model: "opus", usage: tokens(130) },
      { model: "sonnet", usage: tokens(20) },
    ]);
  });

  it("breaks down by reviewer with the agent_ids the subagent hooks recorded", () => {
    const { db, task, views } = setup();
    const verify = insertRun(db, task.id, { phase: "verify" });
    const subagents = new RunSubagentRepository(db);
    subagents.recordStart(verify.id, { agentId: "a1", agentType: "lunasq-code-reviewer" });
    subagents.recordStart(verify.id, { agentId: "a2", agentType: "lunasq-security-reviewer" });
    subagents.recordStart(verify.id, { agentId: "a3", agentType: "Explore" });
    usage(db, verify.id, rec(1)); // main session: the approver
    usage(db, verify.id, rec(2, { agentId: "a1" }));
    usage(db, verify.id, rec(3, { agentId: "a1" }));
    usage(db, verify.id, rec(4, { agentId: "a2" }));
    usage(db, verify.id, rec(5, { agentId: "a3" })); // subagent that is not a reviewer
    usage(db, verify.id, rec(6, { agentId: "a9" })); // lost hook: it is not known whose it is

    expect(views.usage(task.id)?.byReviewer).toEqual([
      { reviewer: "lunasq-code-reviewer", usage: tokens(5) },
      { reviewer: "lunasq-security-reviewer", usage: tokens(4) },
    ]);
    expect(views.usage(task.id)?.total.inputTokens).toBe(21);
  });

  it("leaves the cost as null in the group that has a record without cost, and only in that one", () => {
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

  it("another Run's hook does not attribute usage to this one", () => {
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
  it("sums per task and omits those without usage", () => {
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
  it("returns the latest id and the tasks with later events, without repeating", () => {
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
      settingsChanged: false,
    });
    expect(views.changesSince(first.id)).toEqual({
      lastId: last.id,
      taskIds: [other.id, task.id],
      settingsChanged: false,
    });
    expect(views.changesSince(last.id)).toEqual({
      lastId: last.id,
      taskIds: [],
      settingsChanged: false,
    });
  });

  it("marks settingsChanged with a settings.updated, which does not belong to any task", () => {
    const { db, views } = setup();
    const event = appendEvent(db, { taskId: null, type: "settings.updated", actor: "human" });
    expect(views.changesSince(event.id - 1)).toEqual({
      lastId: event.id,
      taskIds: [],
      settingsChanged: true,
    });
    expect(views.changesSince(event.id).settingsChanged).toBe(false);
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

  it("returns the project's runs, newest first, with the task", () => {
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

  it("leaves the most recent run of each task in each script", () => {
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

  it("limits the tasks per point and script without a hook displacing another", () => {
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
    // after_merge is the project's oldest run and still shows up.
    expect(rows.find((r) => r.script === "deploy")).toMatchObject({ taskId: old.id });
  });

  it("skips payloads that are not from a hook", () => {
    const { db, project, task, views } = setup();
    appendEvent(db, { taskId: task.id, type: "hook.executed", actor: "system", payload: { x: 1 } });
    expect(views.hookExecutions(project.id, 10)).toEqual([]);
  });
});
