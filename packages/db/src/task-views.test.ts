import { EMPTY_USAGE } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { appendEvent } from "./event-log.ts";
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
    expect(views.usage(task.id)).toEqual({ total: EMPTY_USAGE, byRun: [] });
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
