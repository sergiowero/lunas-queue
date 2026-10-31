import { dependencyGraphReaderContract } from "@lunasq/domain/testing";
import {
  TASK_CREATED,
  TASK_DEPENDENCY_ADDED,
  TASK_DEPENDENCY_REMOVED,
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
import { taskDependencies, tasks } from "./schema.ts";
import { applyTaskTitle, TaskRepository, TaskRepositoryError } from "./tasks.ts";
import { freshDatabase, insertProject, insertTask, migratedDatabase } from "./test-helpers.ts";

const missing = "00000000-0000-4000-8000-000000000999";

function repository() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const repo = new TaskRepository(db);
  const create = (overrides: Partial<TaskCreate> = {}) =>
    repo.create({ projectId: project.id, intent: "Hacer algo", priority: 100, ...overrides });
  return { db, repo, project, create };
}

function errorOf(fn: () => unknown): TaskRepositoryError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TaskRepositoryError) return error;
    throw error;
  }
  throw new Error("no lanzó");
}

describe("TaskRepository.create", () => {
  it("crea la tarea en draft/queued y registra task.created", () => {
    const { db, create, project } = repository();
    const task = create({ tags: ["auth"] });
    expect(task).toMatchObject({
      projectId: project.id,
      intent: "Hacer algo",
      tags: ["auth"],
      priority: 100,
      state: "draft",
      subState: "queued",
      verificationIteration: 0,
      causedBy: null,
    });
    const [event] = listEvents(db, task.id);
    expect(event).toMatchObject({
      type: TASK_CREATED,
      actor: "human",
      payload: {
        projectId: project.id,
        intent: "Hacer algo",
        tags: ["auth"],
        priority: 100,
        causedBy: null,
        dependsOn: [],
      },
    });
  });

  it("crea las aristas iniciales en la misma operación", () => {
    const { repo, create } = repository();
    const a = create();
    const b = create();
    const c = create({ dependsOn: [a.id, b.id], causedBy: a.id });
    expect(c.causedBy).toBe(a.id);
    expect(repo.snapshot().dependenciesOf(c.id)).toEqual([a.id, b.id]);
  });

  it("acepta dependencias de otro proyecto", () => {
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
    ["el proyecto no existe", "project_not_found", { projectId: missing }],
    ["una dependencia no existe", "dependency_not_found", { dependsOn: [missing] }],
    ["causedBy no existe", "caused_by_not_found", { causedBy: missing }],
  ])("falla si %s y no escribe nada", (_, code, overrides) => {
    const { db, create } = repository();
    expect(errorOf(() => create(overrides)).code).toBe(code);
    expect(db.select().from(tasks).all()).toEqual([]);
  });

  it("rechaza depender de una tarea cancelada sin escribir nada", () => {
    const { db, repo, create } = repository();
    const a = create();
    repo.cancel(a.id);
    expect(errorOf(() => create({ dependsOn: [a.id] })).code).toBe("dependency_cancelled");
    expect(db.select().from(tasks).all()).toHaveLength(1);
  });

  it("valida la entrada", () => {
    const { create } = repository();
    expect(() => create({ priority: -1 })).toThrow();
  });
});

describe("TaskRepository lectura", () => {
  it("get devuelve null si no existe", () => {
    expect(repository().repo.get(missing)).toBeNull();
  });

  it("list filtra por proyecto y estado y ordena por prioridad y antigüedad", () => {
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

  it("una fila inválida da invalid_row", () => {
    const { db, repo, project } = repository();
    const row = insertTask(db, project.id, { tags: [42] as unknown as string[] });
    expect(errorOf(() => repo.get(row.id)).code).toBe("invalid_row");
  });
});

describe("TaskRepository.update", () => {
  it("cambia solo los campos enviados y registra antes y después", () => {
    const { db, repo, create } = repository();
    const task = create({ tags: ["a"] });
    const updated = repo.update(task.id, { priority: 900, tags: ["a"] });
    expect(updated).toMatchObject({ priority: 900, tags: ["a"], intent: "Hacer algo" });
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      type: TASK_UPDATED,
      actor: "human",
      payload: { from: { priority: 100 }, to: { priority: 900 } },
    });
  });

  it("sin cambios no registra evento", () => {
    const { db, repo, create } = repository();
    const task = create();
    expect(repo.update(task.id, { priority: 100 })).toMatchObject({ priority: 100 });
    expect(repo.update(task.id, {})).toMatchObject({ priority: 100 });
    expect(listEvents(db, task.id)).toHaveLength(1);
  });

  it("devuelve null si no existe y rechaza tareas terminales", () => {
    const { repo, create } = repository();
    expect(repo.update(missing, { priority: 1 })).toBeNull();
    const task = create();
    repo.cancel(task.id);
    expect(errorOf(() => repo.update(task.id, { priority: 1 })).code).toBe("task_terminal");
  });
});

describe("TaskRepository.cancel", () => {
  it("pasa la tarea a cancelled con su evento task.transitioned", () => {
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

  it("cancelar dos veces se rechaza sin duplicar el evento", () => {
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

describe("TaskRepository aristas", () => {
  it("agrega una arista con su evento en la dependiente", () => {
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

  it("repetir la arista es idempotente: no duplica fila ni evento", () => {
    const { db, repo, create } = repository();
    const a = create();
    const b = create();
    repo.addDependency(b.id, a.id);
    expect(repo.addDependency(b.id, a.id)).toEqual({ created: false });
    expect(db.select().from(taskDependencies).all()).toHaveLength(1);
    expect(listEvents(db, b.id)).toHaveLength(2);
  });

  it("rechaza una arista que cierra un ciclo, con el camino, sin escribir nada", () => {
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

  it("rechaza que una tarea dependa de sí misma", () => {
    const { repo, create } = repository();
    const a = create();
    const error = errorOf(() => repo.addDependency(a.id, a.id));
    expect(error).toMatchObject({ code: "cycle", cycle: [a.id, a.id] });
  });

  it("solo agrega aristas a una tarea en draft", () => {
    const { db, repo, create } = repository();
    const a = create();
    const b = create();
    db.update(tasks).set({ state: "refined", subState: null }).where(eq(tasks.id, b.id)).run();
    expect(errorOf(() => repo.addDependency(b.id, a.id)).code).toBe("task_not_draft");
  });

  it("rechaza depender de una tarea cancelada o inexistente", () => {
    const { repo, create } = repository();
    const a = create();
    const b = create();
    expect(errorOf(() => repo.addDependency(b.id, missing)).code).toBe("dependency_not_found");
    repo.cancel(a.id);
    expect(errorOf(() => repo.addDependency(b.id, a.id)).code).toBe("dependency_cancelled");
  });

  it("devuelve null si la dependiente no existe", () => {
    const { repo, create } = repository();
    expect(repo.addDependency(missing, create().id)).toBeNull();
    expect(repo.removeDependency(missing, create().id)).toBeNull();
    expect(repo.dependencies(missing)).toBeNull();
  });

  it("quita una arista con su evento; quitarla otra vez no hace nada", () => {
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

  it("no quita aristas de una tarea terminal", () => {
    const { repo, create } = repository();
    const a = create();
    const b = create({ dependsOn: [a.id] });
    repo.cancel(b.id);
    expect(errorOf(() => repo.removeDependency(b.id, a.id)).code).toBe("task_terminal");
  });

  it("dependencies lista dependencias y dependientes directos con su estado", () => {
    const { repo, create } = repository();
    const a = create({ intent: "Base" });
    const b = create({ dependsOn: [a.id] });
    const c = create({ dependsOn: [b.id] });
    const deps = repo.dependencies(b.id);
    expect(deps?.dependsOn).toEqual([
      {
        taskId: a.id,
        projectId: a.projectId,
        intent: "Base",
        title: null,
        state: "draft",
        prState: null,
        crossProject: false,
        createdAt: expect.any(Date),
      },
    ]);
    expect(deps?.dependents.map((l) => l.taskId)).toEqual([c.id]);
  });

  it("agregar una arista toma el lock de escritura antes de leer el DAG", () => {
    const { db: first, file } = freshDatabase();
    migrateDatabase(first);
    const project = insertProject(first);
    const a = insertTask(first, project.id);
    const b = insertTask(first, project.id);
    // Segunda conexión, como la de otro proceso, que registra cada consulta que ejecuta.
    const queries: string[] = [];
    const client = new Database(file);
    client.pragma("busy_timeout = 0");
    const second = drizzle({ client, schema, logger: { logQuery: (q) => queries.push(q) } });
    try {
      first.$client.prepare("BEGIN IMMEDIATE").run();
      // IMMEDIATE falla al empezar, sin leer nada; una transacción diferida leería el DAG
      // antes de chocar con el otro escritor.
      expect(() => new TaskRepository(second).addDependency(b.id, a.id)).toThrow(/locked|busy/i);
      expect(queries).toEqual([]);
      first.$client.prepare("ROLLBACK").run();
      expect(new TaskRepository(second).addDependency(b.id, a.id)).toEqual({ created: true });
    } finally {
      client.close();
    }
  });

  it("dos aristas que juntas cerrarían un ciclo: la segunda se rechaza", () => {
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
      id = create({ intent: name }).id;
      ids.set(name, id);
    }
    return id;
  };
  for (const { taskId, dependsOnId } of edges) repo.addDependency(idOf(taskId), idOf(dependsOnId));
  return { reader: repo, idOf };
});

describe("applyTaskTitle", () => {
  it("fija el título una sola vez y registra task.titled", () => {
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

  it("rechaza un título vacío o de más de 72 caracteres", () => {
    const { db, create } = repository();
    const task = create();
    expect(() => db.transaction((tx) => applyTaskTitle(tx, task.id, "  "))).toThrow();
    expect(() => db.transaction((tx) => applyTaskTitle(tx, task.id, "x".repeat(73)))).toThrow();
  });
});
