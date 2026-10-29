import { schedulerStateReaderContract } from "@lunasq/domain/testing";
import { TASK_UPDATED } from "@lunasq/schemas";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appendEvent } from "./event-log.ts";
import { SchedulerStateRepository } from "./scheduler-state.ts";
import { taskDependencies, tasks } from "./schema.ts";
import { transitionTask } from "./task-transitions.ts";
import { insertProject, insertTask, migratedDatabase } from "./test-helpers.ts";

schedulerStateReaderContract("SchedulerStateRepository", (seeds, edges) => {
  const db = migratedDatabase();
  const project = insertProject(db);
  const ids = new Map<string, string>();
  for (const seed of seeds) {
    const row = insertTask(db, project.id, {
      intent: seed.name,
      state: seed.state,
      subState: seed.subState ?? null,
      priority: seed.priority ?? 100,
      prState: seed.prState ?? null,
    });
    ids.set(seed.name, row.id);
  }
  const idOf = (name: string) => {
    const id = ids.get(name);
    if (!id) throw new Error(`sin tarea ${name}`);
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

  it("sin transiciones es la creación de la tarea", () => {
    const { db, project, readySince } = setup();
    const createdAt = new Date("2026-10-01T00:00:00Z");
    const task = insertTask(db, project.id, { createdAt });
    expect(readySince(task.id)).toBe(createdAt.getTime());
  });

  it("es la última transición de la tarea", () => {
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

  it("otros eventos, como editar la prioridad, no reinician el aging", () => {
    const { db, project, readySince } = setup();
    const createdAt = new Date("2026-10-01T00:00:00Z");
    const task = insertTask(db, project.id, { createdAt });
    appendEvent(db, { taskId: task.id, type: TASK_UPDATED, actor: "human", payload: {} });
    expect(readySince(task.id)).toBe(createdAt.getTime());
  });

  it("cuenta desde que cambió por última vez una dependencia (su merge)", () => {
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

  it("lee también las aristas entre proyectos", () => {
    const { db, project, repo } = setup();
    const other = insertProject(db);
    const dep = insertTask(db, other.id);
    const task = insertTask(db, project.id);
    db.insert(taskDependencies).values({ taskId: task.id, dependsOnId: dep.id }).run();
    expect(repo.snapshot().edges).toEqual([{ taskId: task.id, dependsOnId: dep.id }]);
  });
});
