import { schedulerStateReaderContract } from "@lunasq/domain/testing";
import { TASK_UPDATED } from "@lunasq/schemas";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appendEvent } from "./event-log.ts";
import { SchedulerStateRepository } from "./scheduler-state.ts";
import { taskDependencies, tasks } from "./schema.ts";
import { transitionTask } from "./task-transitions.ts";
import { insertProject, insertRun, insertTask, migratedDatabase } from "./test-helpers.ts";

schedulerStateReaderContract("SchedulerStateRepository", (seeds, edges) => {
  const db = migratedDatabase();
  const project = insertProject(db);
  const ids = new Map<string, string>();
  for (const seed of seeds) {
    const row = insertTask(db, project.id, {
      goal: seed.name,
      state: seed.state,
      subState: seed.subState ?? null,
      priority: seed.priority ?? 100,
      prState: seed.prState ?? null,
      resultKind: seed.resultKind ?? null,
    });
    ids.set(seed.name, row.id);
  }
  const idOf = (name: string) => {
    const id = ids.get(name);
    if (!id) throw new Error(`no task ${name}`);
    return id;
  };
  if (edges.length > 0) {
    db.insert(taskDependencies)
      .values(edges.map((e) => ({ taskId: idOf(e.taskId), dependsOnId: idOf(e.dependsOnId) })))
      .run();
  }
  return { reader: new SchedulerStateRepository(db), idOf };
});

describe("SchedulerStateRepository: readySince", () => {
  function setup() {
    const db = migratedDatabase();
    const project = insertProject(db);
    const repo = new SchedulerStateRepository(db);
    const readySince = (taskId: string) =>
      repo
        .snapshot()
        .tasks.find((t) => t.id === taskId)
        ?.readySince.getTime();
    return { db, project, repo, readySince };
  }

  it("without transitions it is the task's creation", () => {
    const { db, project, readySince } = setup();
    const createdAt = new Date("2026-10-01T00:00:00Z");
    const task = insertTask(db, project.id, { createdAt });
    expect(readySince(task.id)).toBe(createdAt.getTime());
  });

  it("it is the task's last transition", () => {
    const { db, project, readySince } = setup();
    const task = insertTask(db, project.id, { createdAt: new Date("2026-10-01T00:00:00Z") });
    const run = (command: Parameters<typeof transitionTask>[1]["command"]) => {
      const result = transitionTask(db, { taskId: task.id, actor: "system", command });
      if (!result.ok) throw new Error(result.error.code);
      return result.event;
    };
    run({ type: "dispatch" });
    const last = run({ type: "run_failed", attempt: 1 });
    expect(readySince(task.id)).toBe(last.createdAt.getTime());
  });

  it("other events, such as editing the priority, do not reset the aging", () => {
    const { db, project, readySince } = setup();
    const createdAt = new Date("2026-10-01T00:00:00Z");
    const task = insertTask(db, project.id, { createdAt });
    appendEvent(db, { taskId: task.id, type: TASK_UPDATED, actor: "human", payload: {} });
    expect(readySince(task.id)).toBe(createdAt.getTime());
  });

  it("counts from the last time a dependency changed (its merge)", () => {
    const { db, project, readySince } = setup();
    const createdAt = new Date("2026-10-01T00:00:00Z");
    const mergedAt = new Date("2026-10-20T00:00:00Z");
    const dep = insertTask(db, project.id, {
      state: "completed",
      subState: null,
      prState: "merged",
    });
    db.update(tasks).set({ updatedAt: mergedAt }).where(eq(tasks.id, dep.id)).run();
    const task = insertTask(db, project.id, { createdAt });
    db.insert(taskDependencies).values({ taskId: task.id, dependsOnId: dep.id }).run();
    expect(readySince(task.id)).toBe(mergedAt.getTime());
  });

  it("counts from when a dependency was completed with a Result", () => {
    const { db, project, readySince } = setup();
    const createdAt = new Date("2026-10-01T00:00:00Z");
    const completedAt = new Date("2026-10-22T00:00:00Z");
    const dep = insertTask(db, project.id, {
      state: "completed",
      subState: null,
      resultKind: "research",
      result: "hallazgos",
    });
    db.update(tasks).set({ updatedAt: completedAt }).where(eq(tasks.id, dep.id)).run();
    const task = insertTask(db, project.id, { createdAt });
    db.insert(taskDependencies).values({ taskId: task.id, dependsOnId: dep.id }).run();
    expect(readySince(task.id)).toBe(completedAt.getTime());
  });

  it("ignores changes of a dependency that is not merged yet", () => {
    const { db, project, readySince } = setup();
    const createdAt = new Date("2026-10-01T00:00:00Z");
    const dep = insertTask(db, project.id, { state: "in_progress", subState: "running" });
    db.update(tasks)
      .set({ updatedAt: new Date("2026-10-20T00:00:00Z") })
      .where(eq(tasks.id, dep.id))
      .run();
    const task = insertTask(db, project.id, { createdAt });
    db.insert(taskDependencies).values({ taskId: task.id, dependsOnId: dep.id }).run();
    expect(readySince(task.id)).toBe(createdAt.getTime());
  });

  it("also reads edges between projects", () => {
    const { db, project, repo } = setup();
    const other = insertProject(db);
    const dep = insertTask(db, other.id);
    const task = insertTask(db, project.id);
    db.insert(taskDependencies).values({ taskId: task.id, dependsOnId: dep.id }).run();
    expect(repo.snapshot().edges).toEqual([{ taskId: task.id, dependsOnId: dep.id }]);
  });
});

describe("SchedulerStateRepository: retry", () => {
  function setup() {
    const db = migratedDatabase();
    const project = insertProject(db);
    const repo = new SchedulerStateRepository(db);
    const retry = (taskId: string) => repo.snapshot().tasks.find((t) => t.id === taskId)?.retry;
    return { db, project, retry };
  }
  const at = (s: number) => new Date(Date.UTC(2026, 9, 29, 12, 0, s));

  it("counts the consecutive failed Runs of the pending phase and the end of the last one", () => {
    const { db, project, retry } = setup();
    const task = insertTask(db, project.id, { state: "in_progress", subState: "queued" });
    insertRun(db, task.id, { startedAt: at(0), endedAt: at(1), result: "failure" });
    insertRun(db, task.id, { startedAt: at(2), endedAt: at(3), result: "failure" });
    expect(retry(task.id)).toEqual({ failures: 2, lastFailedAt: at(3) });
  });

  it("a later successful Run breaks the streak", () => {
    const { db, project, retry } = setup();
    const task = insertTask(db, project.id, { state: "in_progress", subState: "queued" });
    insertRun(db, task.id, { startedAt: at(0), endedAt: at(1), result: "failure" });
    insertRun(db, task.id, { startedAt: at(2), endedAt: at(3), result: "success" });
    expect(retry(task.id)).toBeUndefined();
  });

  it("failures of another phase do not count", () => {
    const { db, project, retry } = setup();
    const task = insertTask(db, project.id, { state: "in_progress", subState: "queued" });
    insertRun(db, task.id, {
      phase: "refine",
      startedAt: at(0),
      endedAt: at(1),
      result: "failure",
    });
    expect(retry(task.id)).toBeUndefined();
  });

  it("only applies to tasks in queued", () => {
    const { db, project, retry } = setup();
    const task = insertTask(db, project.id, { state: "in_progress", subState: "running" });
    insertRun(db, task.id, { startedAt: at(0), endedAt: at(1), result: "failure" });
    expect(retry(task.id)).toBeUndefined();
  });
});

describe("SchedulerStateRepository: live agent's provider", () => {
  function setup() {
    const db = migratedDatabase();
    const project = insertProject(db);
    const repo = new SchedulerStateRepository(db);
    const agentKind = (taskId: string) =>
      repo.snapshot().tasks.find((t) => t.id === taskId)?.agentKind;
    return { db, project, agentKind };
  }

  it("is the provider of the open Run, which may be a profile fallback", () => {
    const { db, project, agentKind } = setup();
    const task = insertTask(db, project.id, { state: "in_progress", subState: "running" });
    insertRun(db, task.id, { agentKind: "claude", endedAt: new Date(), result: "failure" });
    insertRun(db, task.id, { agentKind: "copilot" });
    expect(agentKind(task.id)).toBe("copilot");
  });

  it("a task without an open Run does not have one", () => {
    const { db, project, agentKind } = setup();
    const task = insertTask(db, project.id, { state: "in_progress", subState: "queued" });
    insertRun(db, task.id, { agentKind: "copilot", endedAt: new Date(), result: "failure" });
    expect(agentKind(task.id)).toBeUndefined();
  });
});
