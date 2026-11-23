import { dependencyGraphReaderContract } from "@lunasq/domain/testing";
import {
  TASK_CREATED,
  TASK_DEPENDENCY_ADDED,
  TASK_DEPENDENCY_REMOVED,
  TASK_INSTRUCTION_ADDED,
  TASK_INSTRUCTION_REMOVED,
  TASK_INSTRUCTION_UPDATED,
  TASK_TITLED,
  TASK_TRANSITIONED,
  TASK_UPDATED,
  type TaskCreate,
} from "@lunasq/schemas";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "./client.ts";
import { listEvents } from "./event-log.ts";
import * as schema from "./schema.ts";
import { taskDependencies, taskInstructions, tasks } from "./schema.ts";
import {
  applyTaskTitle,
  completeTaskWithResult,
  TaskRepository,
  TaskRepositoryError,
} from "./tasks.ts";
import { freshDatabase, insertProject, insertTask, migratedDatabase } from "./test-helpers.ts";

const missing = "00000000-0000-4000-8000-000000000999";

function repository() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const repo = new TaskRepository(db);
  const create = (overrides: Partial<TaskCreate> = {}) =>
    repo.create({ projectId: project.id, goal: "Hacer algo", priority: 100, ...overrides });
  return { db, repo, project, create };
}

function errorOf(fn: () => unknown): TaskRepositoryError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TaskRepositoryError) return error;
    throw error;
  }
  throw new Error("it did not throw");
}

describe("TaskRepository.create", () => {
  it("creates the task in draft/queued and records task.created", () => {
    const { db, create, project } = repository();
    const task = create({ tags: ["auth"] });
    expect(task).toMatchObject({
      projectId: project.id,
      goal: "Hacer algo",
      tags: ["auth"],
      priority: 100,
      state: "draft",
      subState: "queued",
      verificationIteration: 0,
      verificationCycleStart: 0,
      causedBy: null,
    });
    const [event] = listEvents(db, task.id);
    expect(event).toMatchObject({
      type: TASK_CREATED,
      actor: "human",
      payload: {
        projectId: project.id,
        goal: "Hacer algo",
        tags: ["auth"],
        priority: 100,
        causedBy: null,
        dependsOn: [],
      },
    });
  });

  it("creates the initial edges in the same operation", () => {
    const { repo, create } = repository();
    const a = create();
    const b = create();
    const c = create({ dependsOn: [a.id, b.id], causedBy: a.id });
    expect(c.causedBy).toBe(a.id);
    expect(repo.snapshot().dependenciesOf(c.id)).toEqual([a.id, b.id]);
  });

  it("accepts dependencies from another project", () => {
    const { db, repo, create } = repository();
    const other = insertProject(db);
    const a = create({ projectId: other.id });
    const b = create({ dependsOn: [a.id] });
    const c = create();
    const d = create({ dependsOn: [a.id, c.id] });
    expect(repo.dependencies(b.id)?.dependsOn).toMatchObject([
      { taskId: a.id, crossProject: true },
    ]);
    expect(listEvents(db, d.id)[0]?.payload).toMatchObject({
      dependsOn: [
        { dependsOnId: a.id, crossProject: true },
        { dependsOnId: c.id, crossProject: false },
      ],
    });
  });

  it.each<[string, string, Partial<TaskCreate>]>([
    ["the project does not exist", "project_not_found", { projectId: missing }],
    ["a dependency does not exist", "dependency_not_found", { dependsOn: [missing] }],
    ["causedBy does not exist", "caused_by_not_found", { causedBy: missing }],
  ])("fails if %s and writes nothing", (_, code, overrides) => {
    const { db, create } = repository();
    expect(errorOf(() => create(overrides)).code).toBe(code);
    expect(db.select().from(tasks).all()).toEqual([]);
  });

  it("refuses to depend on a canceled task without writing anything", () => {
    const { db, repo, create } = repository();
    const a = create();
    repo.cancel(a.id);
    expect(errorOf(() => create({ dependsOn: [a.id] })).code).toBe("dependency_cancelled");
    expect(db.select().from(tasks).all()).toHaveLength(1);
  });

  it("validates the input", () => {
    const { create } = repository();
    expect(() => create({ priority: -1 })).toThrow();
  });
});

describe("TaskRepository reading", () => {
  it("get returns null if it does not exist", () => {
    expect(repository().repo.get(missing)).toBeNull();
  });

  it("list filters by project and state and orders by priority and age", () => {
    const { db, repo, create } = repository();
    const other = insertProject(db);
    const low = create({ priority: 100 });
    const high = create({ priority: 900 });
    const tie = create({ priority: 900 });
    const foreign = create({ projectId: other.id });
    repo.cancel(low.id);

    expect(repo.list().map((t) => t.id)).toEqual([high.id, tie.id, low.id, foreign.id]);
    expect(repo.list({ projectId: other.id }).map((t) => t.id)).toEqual([foreign.id]);
    expect(repo.list({ state: "cancelled" }).map((t) => t.id)).toEqual([low.id]);
  });

  it("an invalid row gives invalid_row", () => {
    const { db, repo, project } = repository();
    const row = insertTask(db, project.id, { tags: [42] as unknown as string[] });
    expect(errorOf(() => repo.get(row.id)).code).toBe("invalid_row");
  });
});

describe("TaskRepository.update", () => {
  it("changes only the fields sent and records before and after", () => {
    const { db, repo, create } = repository();
    const task = create({ tags: ["a"] });
    const updated = repo.update(task.id, { priority: 900, tags: ["a"] });
    expect(updated).toMatchObject({ priority: 900, tags: ["a"], goal: "Hacer algo" });
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      type: TASK_UPDATED,
      actor: "human",
      payload: { from: { priority: 100 }, to: { priority: 900 } },
    });
  });

  it("without changes it records no event", () => {
    const { db, repo, create } = repository();
    const task = create();
    expect(repo.update(task.id, { priority: 100 })).toMatchObject({ priority: 100 });
    expect(repo.update(task.id, {})).toMatchObject({ priority: 100 });
    expect(listEvents(db, task.id)).toHaveLength(1);
  });

  it("returns null if it does not exist and rejects terminal tasks", () => {
    const { repo, create } = repository();
    expect(repo.update(missing, { priority: 1 })).toBeNull();
    const task = create();
    repo.cancel(task.id);
    expect(errorOf(() => repo.update(task.id, { priority: 1 })).code).toBe("task_terminal");
  });
});

describe("TaskRepository.cancel", () => {
  it("moves the task to cancelled with its task.transitioned event", () => {
    const { db, repo, create } = repository();
    const task = create();
    const result = repo.cancel(task.id, "ya no aplica");
    expect(result).toMatchObject({ ok: true, task: { state: "cancelled", subState: null } });
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      type: TASK_TRANSITIONED,
      actor: "human",
      payload: { command: "cancel", note: "ya no aplica" },
    });
  });

  it("canceling twice is rejected without duplicating the event", () => {
    const { db, repo, create } = repository();
    const task = create();
    repo.cancel(task.id);
    expect(repo.cancel(task.id)).toMatchObject({
      ok: false,
      error: { code: "invalid_transition" },
    });
    expect(listEvents(db, task.id)).toHaveLength(2);
  });
});

describe("TaskRepository edges", () => {
  it("adds an edge with its event on the dependent", () => {
    const { db, repo, create } = repository();
    const a = create();
    const b = create();
    expect(repo.addDependency(b.id, a.id)).toEqual({ created: true });
    expect(repo.snapshot().dependenciesOf(b.id)).toEqual([a.id]);
    expect(listEvents(db, b.id).at(-1)).toMatchObject({
      type: TASK_DEPENDENCY_ADDED,
      payload: { dependsOnId: a.id, crossProject: false },
    });
  });

  it("repeating the edge is idempotent: it duplicates neither row nor event", () => {
    const { db, repo, create } = repository();
    const a = create();
    const b = create();
    repo.addDependency(b.id, a.id);
    expect(repo.addDependency(b.id, a.id)).toEqual({ created: false });
    expect(db.select().from(taskDependencies).all()).toHaveLength(1);
    expect(listEvents(db, b.id)).toHaveLength(2);
  });

  it("rejects an edge that closes a cycle, with the path, without writing anything", () => {
    const { db, repo, create } = repository();
    const a = create();
    const b = create({ dependsOn: [a.id] });
    const c = create({ dependsOn: [b.id] });
    const error = errorOf(() => repo.addDependency(a.id, c.id));
    expect(error.code).toBe("cycle");
    expect(error.cycle).toEqual([a.id, c.id, b.id, a.id]);
    expect(db.select().from(taskDependencies).all()).toHaveLength(2);
    expect(listEvents(db, a.id)).toHaveLength(1);
  });

  it("rejects a task depending on itself", () => {
    const { repo, create } = repository();
    const a = create();
    const error = errorOf(() => repo.addDependency(a.id, a.id));
    expect(error).toMatchObject({ code: "cycle", cycle: [a.id, a.id] });
  });

  it("only adds edges to a task in draft", () => {
    const { db, repo, create } = repository();
    const a = create();
    const b = create();
    db.update(tasks).set({ state: "refined", subState: null }).where(eq(tasks.id, b.id)).run();
    expect(errorOf(() => repo.addDependency(b.id, a.id)).code).toBe("task_not_draft");
  });

  it("rejects depending on a canceled or nonexistent task", () => {
    const { repo, create } = repository();
    const a = create();
    const b = create();
    expect(errorOf(() => repo.addDependency(b.id, missing)).code).toBe("dependency_not_found");
    repo.cancel(a.id);
    expect(errorOf(() => repo.addDependency(b.id, a.id)).code).toBe("dependency_cancelled");
  });

  it("returns null if the dependent does not exist", () => {
    const { repo, create } = repository();
    expect(repo.addDependency(missing, create().id)).toBeNull();
    expect(repo.removeDependency(missing, create().id)).toBeNull();
    expect(repo.dependencies(missing)).toBeNull();
  });

  it("removes an edge with its event; removing it again does nothing", () => {
    const { db, repo, create } = repository();
    const a = create();
    const b = create({ dependsOn: [a.id] });
    db.update(tasks).set({ state: "in_progress" }).where(eq(tasks.id, b.id)).run();
    expect(repo.removeDependency(b.id, a.id)).toEqual({ removed: true });
    expect(repo.removeDependency(b.id, a.id)).toEqual({ removed: false });
    expect(repo.snapshot().edges()).toEqual([]);
    expect(listEvents(db, b.id).map((e) => e.type)).toEqual([
      TASK_CREATED,
      TASK_DEPENDENCY_REMOVED,
    ]);
  });

  it("does not remove edges from a terminal task", () => {
    const { repo, create } = repository();
    const a = create();
    const b = create({ dependsOn: [a.id] });
    repo.cancel(b.id);
    expect(errorOf(() => repo.removeDependency(b.id, a.id)).code).toBe("task_terminal");
  });

  it("dependencies lists direct dependencies and dependents with their state", () => {
    const { repo, create } = repository();
    const a = create({ goal: "Base" });
    const b = create({ dependsOn: [a.id] });
    const c = create({ dependsOn: [b.id] });
    const deps = repo.dependencies(b.id);
    expect(deps?.dependsOn).toEqual([
      {
        taskId: a.id,
        number: a.number,
        projectId: a.projectId,
        goal: "Base",
        title: null,
        state: "draft",
        prState: null,
        crossProject: false,
        createdAt: expect.any(Date),
      },
    ]);
    expect(deps?.dependents.map((l) => [l.taskId, l.number])).toEqual([[c.id, c.number]]);
  });

  it("adding an edge takes the write lock before reading the DAG", () => {
    const { db: first, file } = freshDatabase();
    migrateDatabase(first);
    const project = insertProject(first);
    const a = insertTask(first, project.id);
    const b = insertTask(first, project.id);
    // Second connection, like another process's, which logs every query it runs.
    const queries: string[] = [];
    const client = new Database(file);
    client.pragma("busy_timeout = 0");
    const second = drizzle({ client, schema, logger: { logQuery: (q) => queries.push(q) } });
    try {
      first.$client.prepare("BEGIN IMMEDIATE").run();
      // IMMEDIATE fails at the start, without reading anything; a deferred transaction would read the DAG
      // before colliding with the other writer.
      expect(() => new TaskRepository(second).addDependency(b.id, a.id)).toThrow(/locked|busy/i);
      expect(queries).toEqual([]);
      first.$client.prepare("ROLLBACK").run();
      expect(new TaskRepository(second).addDependency(b.id, a.id)).toEqual({ created: true });
    } finally {
      client.close();
    }
  });

  it("two edges that together would close a cycle: the second is rejected", () => {
    const { repo, create } = repository();
    const a = create();
    const b = create();
    repo.addDependency(a.id, b.id);
    expect(errorOf(() => repo.addDependency(b.id, a.id)).code).toBe("cycle");
  });
});

dependencyGraphReaderContract("TaskRepository", (edges) => {
  const { repo, create } = repository();
  const ids = new Map<string, string>();
  const idOf = (name: string) => {
    let id = ids.get(name);
    if (!id) {
      id = create({ goal: name }).id;
      ids.set(name, id);
    }
    return id;
  };
  for (const { taskId, dependsOnId } of edges) repo.addDependency(idOf(taskId), idOf(dependsOnId));
  return { reader: repo, idOf };
});

describe("applyTaskTitle", () => {
  it("sets the title only once and records task.titled", () => {
    const { db, repo, create } = repository();
    const task = create();
    expect(task.title).toBeNull();

    expect(db.transaction((tx) => applyTaskTitle(tx, task.id, "  Primer título "))).toBe(true);
    expect(db.transaction((tx) => applyTaskTitle(tx, task.id, "Otro título"))).toBe(false);

    expect(repo.get(task.id)?.title).toBe("Primer título");
    const titled = listEvents(db, task.id).filter((e) => e.type === TASK_TITLED);
    expect(titled).toHaveLength(1);
    expect(titled[0]).toMatchObject({ actor: "agent", payload: { title: "Primer título" } });
  });

  it("rejects an empty title or one longer than 72 characters", () => {
    const { db, create } = repository();
    const task = create();
    expect(() => db.transaction((tx) => applyTaskTitle(tx, task.id, "  "))).toThrow();
    expect(() => db.transaction((tx) => applyTaskTitle(tx, task.id, "x".repeat(73)))).toThrow();
  });
});

describe("completeTaskWithResult", () => {
  const input = (
    taskId: string,
    extra: Partial<Parameters<typeof completeTaskWithResult>[1]> = {},
  ) => ({
    taskId,
    resultKind: "research" as const,
    result: "# Hallazgos",
    title: "Investigar la cola",
    expected: { state: "draft", subState: "running" } as const,
    ...extra,
  });

  it("completes the task with a Result, sets the title and leaves the events, without a PR", () => {
    const { db, repo, create } = repository();
    const task = create();
    db.update(tasks).set({ subState: "running" }).where(eq(tasks.id, task.id)).run();

    const result = db.transaction((tx) => completeTaskWithResult(tx, input(task.id)), {
      behavior: "immediate",
    });

    expect(result.ok).toBe(true);
    expect(repo.get(task.id)).toMatchObject({
      state: "completed",
      subState: null,
      resultKind: "research",
      result: "# Hallazgos",
      title: "Investigar la cola",
      prUrl: null,
      prState: null,
    });
    const events = listEvents(db, task.id);
    expect(events.filter((e) => e.type === TASK_TITLED)).toHaveLength(1);
    const moved = events.filter((e) => e.type === TASK_TRANSITIONED).at(-1);
    expect(moved).toMatchObject({
      actor: "agent",
      payload: {
        command: "submit_result",
        from: { state: "draft", subState: "running" },
        to: { state: "completed", subState: null },
        note: "research",
      },
    });
  });

  it("does not change the title the task already has", () => {
    const { db, repo, create } = repository();
    const task = create();
    db.update(tasks)
      .set({ state: "in_progress", subState: "running", title: "Título previo" })
      .where(eq(tasks.id, task.id))
      .run();

    const result = db.transaction(
      (tx) =>
        completeTaskWithResult(
          tx,
          input(task.id, {
            resultKind: "already_implemented",
            expected: { state: "in_progress", subState: "running" },
          }),
        ),
      { behavior: "immediate" },
    );

    expect(result.ok).toBe(true);
    expect(repo.get(task.id)).toMatchObject({
      state: "completed",
      title: "Título previo",
      resultKind: "already_implemented",
    });
    expect(listEvents(db, task.id).filter((e) => e.type === TASK_TITLED)).toHaveLength(0);
  });

  it("if the state machine rejects, it writes neither Result nor title", () => {
    const { db, repo, create } = repository();
    const task = create(); // draft/queued: submit_result only applies from running

    const { expected: _, ...withoutExpected } = input(task.id);
    const result = db.transaction((tx) => completeTaskWithResult(tx, withoutExpected), {
      behavior: "immediate",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    expect(repo.get(task.id)).toMatchObject({
      state: "draft",
      title: null,
      resultKind: null,
      result: null,
    });
  });
});

describe("task number", () => {
  it("a new task gets the next global number and keeps its UUID as id", () => {
    const { db, repo, create } = repository();
    for (let i = 0; i < 3; i++) create();
    const other = insertProject(db);
    const task = repo.create({ projectId: other.id, goal: "Otra cosa", priority: 1 });
    expect(task.number).toBe(4);
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(repo.get(task.id)?.number).toBe(4);
  });

  it("two consecutive creations have consecutive numbers and the database rejects a repeated number", () => {
    const { db, project, create } = repository();
    const first = create();
    const second = create();
    expect(second.number).toBe(first.number + 1);
    expect(() => insertTask(db, project.id, { number: first.number })).toThrow(
      /UNIQUE constraint failed: tasks.number/,
    );
  });

  it("the number does not change on edit or transition, and the database does not allow changing it", () => {
    const { db, repo, create } = repository();
    for (let i = 0; i < 6; i++) create();
    const task = create();
    expect(task.number).toBe(7);
    expect(repo.update(task.id, { goal: "Otro goal", tags: ["x"], priority: 5 })?.number).toBe(7);
    const cancelled = repo.cancel(task.id);
    expect(cancelled.ok && cancelled.task.number).toBe(7);
    expect(repo.get(task.id)?.number).toBe(7);
    expect(() =>
      db.$client.prepare("update tasks set number = 99 where id = ?").run(task.id),
    ).toThrow(/el número de una tarea no cambia/);
  });

  it("does not reuse the number of a canceled task", () => {
    const { repo, create } = repository();
    create();
    const last = create();
    repo.cancel(last.id);
    expect(create().number).toBe(last.number + 1);
  });

  it("task.created records the assigned number", () => {
    const { db, create } = repository();
    const task = create();
    expect(listEvents(db, task.id)[0]?.payload).toMatchObject({ number: task.number });
  });
});

describe("phase instructions", () => {
  const eventTypes = (db: ReturnType<typeof migratedDatabase>, taskId: string) =>
    listEvents(db, taskId).map((e) => e.type);

  it("a task created with instructions stores them, oldest first, and records task.instruction_added", () => {
    const { db, repo, create } = repository();
    const task = create({
      instructions: [
        { phase: "implement", text: "do not add dependencies" },
        { phase: "verify", text: "  run the e2e suite " },
      ],
    });
    expect(repo.instructions(task.id)).toMatchObject([
      { phase: "implement", text: "do not add dependencies" },
      { phase: "verify", text: "run the e2e suite" },
    ]);
    const added = listEvents(db, task.id).filter((e) => e.type === TASK_INSTRUCTION_ADDED);
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({
      actor: "human",
      payload: { phase: "implement", text: "do not add dependencies" },
    });
    expect(added[0]?.payload).toMatchObject({ instructionId: repo.instructions(task.id)?.[0]?.id });
  });

  it("a task without instructions has an empty list; an unknown task has null", () => {
    const { repo, create } = repository();
    expect(repo.instructions(create().id)).toEqual([]);
    expect(repo.instructions(missing)).toBeNull();
  });

  it("an invalid instruction at creation stores nothing", () => {
    const { db, repo, create } = repository();
    expect(() => create({ instructions: [{ phase: "deliver" as "refine", text: "x" }] })).toThrow();
    expect(repo.list()).toEqual([]);
    expect(db.select().from(taskInstructions).all()).toEqual([]);
  });

  it("adds an instruction to a task in any state, even completed, without touching its state", () => {
    const { db, repo, project } = repository();
    for (const state of ["draft", "in_progress", "completed", "cancelled"] as const) {
      const task = insertTask(db, project.id, { state, subState: null, verificationIteration: 2 });
      const before = repo.get(task.id);
      const added = repo.addInstruction(task.id, { phase: "verify", text: "check the docs" });
      expect(added).toMatchObject({ phase: "verify", text: "check the docs" });
      expect(eventTypes(db, task.id)).toEqual([TASK_INSTRUCTION_ADDED]);
      const after = repo.get(task.id);
      expect(after).toMatchObject({
        state: before?.state,
        subState: before?.subState,
        verificationIteration: 2,
      });
      expect(after?.updatedAt).toEqual(before?.updatedAt);
    }
  });

  it("adding to an unknown task returns null", () => {
    const { repo } = repository();
    expect(repo.addInstruction(missing, { phase: "refine", text: "x" })).toBeNull();
  });

  it.each([
    ["deliver phase", { phase: "deliver", text: "x" }],
    ["empty text", { phase: "refine", text: "  " }],
    ["text over 10,000 characters", { phase: "refine", text: "x".repeat(10_001) }],
  ])("rejects adding an instruction with %s and stores nothing", (_, input) => {
    const { db, repo, create } = repository();
    const task = create();
    expect(() => repo.addInstruction(task.id, input as never)).toThrow();
    expect(repo.instructions(task.id)).toEqual([]);
    expect(eventTypes(db, task.id)).toEqual([TASK_CREATED]);
  });

  it("rejects the 51st instruction and keeps 50", () => {
    const { db, repo, create } = repository();
    const task = create({
      instructions: Array.from({ length: 50 }, (_, i) => ({ phase: "refine", text: `n${i}` })),
    });
    const error = errorOf(() =>
      repo.addInstruction(task.id, { phase: "refine", text: "one more" }),
    );
    expect(error.code).toBe("instruction_limit");
    expect(repo.instructions(task.id)).toHaveLength(50);
    expect(listEvents(db, task.id).filter((e) => e.type === TASK_INSTRUCTION_ADDED)).toHaveLength(
      50,
    );
  });

  it("changing text and phase stores the new values and records from and to", () => {
    const { db, repo, create } = repository();
    const task = create({ instructions: [{ phase: "refine", text: "old" }] });
    const [instruction] = repo.instructions(task.id) ?? [];
    const updated = repo.updateInstruction(task.id, instruction?.id ?? "", {
      text: "new",
      phase: "verify",
    });
    expect(updated).toEqual({ id: instruction?.id, phase: "verify", text: "new" });
    expect(repo.instructions(task.id)).toEqual([updated]);
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      type: TASK_INSTRUCTION_UPDATED,
      actor: "human",
      payload: {
        instructionId: instruction?.id,
        from: { text: "old", phase: "refine" },
        to: { text: "new", phase: "verify" },
      },
    });
  });

  it("an edit with only one changed field records only that field; with none, no event", () => {
    const { db, repo, create } = repository();
    const task = create({ instructions: [{ phase: "refine", text: "same" }] });
    const id = repo.instructions(task.id)?.[0]?.id ?? "";
    repo.updateInstruction(task.id, id, { text: "same", phase: "implement" });
    expect(listEvents(db, task.id).at(-1)?.payload).toEqual({
      instructionId: id,
      from: { phase: "refine" },
      to: { phase: "implement" },
    });
    const events = listEvents(db, task.id).length;
    expect(repo.updateInstruction(task.id, id, { text: " same ", phase: "implement" })).toEqual({
      id,
      phase: "implement",
      text: "same",
    });
    expect(listEvents(db, task.id)).toHaveLength(events);
  });

  it("editing keeps the position of the instruction in the list", () => {
    const { repo, create } = repository();
    const task = create({
      instructions: [
        { phase: "refine", text: "a" },
        { phase: "refine", text: "b" },
      ],
    });
    const first = repo.instructions(task.id)?.[0]?.id ?? "";
    repo.updateInstruction(task.id, first, { text: "a2" });
    expect(repo.instructions(task.id)?.map((i) => i.text)).toEqual(["a2", "b"]);
  });

  it("removes an instruction, records task.instruction_removed and removing again is not found", () => {
    const { db, repo, create } = repository();
    const task = create({
      instructions: [
        { phase: "implement", text: "a" },
        { phase: "refine", text: "b" },
      ],
    });
    const id = repo.instructions(task.id)?.[0]?.id ?? "";
    expect(repo.removeInstruction(task.id, id)).toBe(true);
    expect(repo.instructions(task.id)?.map((i) => i.text)).toEqual(["b"]);
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      type: TASK_INSTRUCTION_REMOVED,
      actor: "human",
      payload: { instructionId: id, phase: "implement" },
    });
    const events = listEvents(db, task.id).length;
    expect(repo.removeInstruction(task.id, id)).toBe(false);
    expect(listEvents(db, task.id)).toHaveLength(events);
  });

  it("an instruction of another task, or of an unknown task, is not found and nothing changes", () => {
    const { db, repo, create } = repository();
    const a = create({ instructions: [{ phase: "refine", text: "of a" }] });
    const b = create();
    const id = repo.instructions(a.id)?.[0]?.id ?? "";
    const events = listEvents(db, a.id).length;
    expect(repo.updateInstruction(b.id, id, { text: "hijacked" })).toBeNull();
    expect(repo.removeInstruction(b.id, id)).toBe(false);
    expect(repo.updateInstruction(missing, id, { text: "x" })).toBeNull();
    expect(repo.removeInstruction(missing, id)).toBe(false);
    expect(repo.instructions(a.id)?.[0]?.text).toBe("of a");
    expect(listEvents(db, a.id)).toHaveLength(events);
    expect(listEvents(db, b.id)).toHaveLength(1);
  });

  it("edits and removes work on a completed task", () => {
    const { db, repo, project } = repository();
    const task = insertTask(db, project.id, { state: "completed", subState: null });
    const added = repo.addInstruction(task.id, { phase: "verify", text: "x" });
    expect(repo.updateInstruction(task.id, added?.id ?? "", { text: "y" })?.text).toBe("y");
    expect(repo.removeInstruction(task.id, added?.id ?? "")).toBe(true);
    expect(repo.get(task.id)).toMatchObject({ state: "completed" });
  });
});
