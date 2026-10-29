import { describe, expect, it } from "vitest";
import {
  DependencyLink,
  TASK_CREATED,
  TASK_DEPENDENCY_ADDED,
  TASK_DEPENDENCY_REMOVED,
  TASK_UPDATED,
  Task,
  TaskCancel,
  TaskCreate,
  TaskCreatedPayload,
  TaskDependencyPayload,
  TaskListQuery,
  TaskUpdate,
  TaskUpdatedPayload,
} from "./index.ts";

const projectId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";

const validCreate = { projectId, intent: "Agregar login con GitHub", priority: 100 };

describe("TaskCreate", () => {
  it("acepta lo mínimo y rellena tags y dependencias vacías", () => {
    expect(TaskCreate.parse(validCreate)).toEqual({ ...validCreate, tags: [], dependsOn: [] });
  });

  it("recorta el intent y las tags y quita duplicados", () => {
    const parsed = TaskCreate.parse({
      ...validCreate,
      intent: "  Agregar login  ",
      tags: [" auth ", "auth", "ui"],
      dependsOn: [otherId, otherId],
    });
    expect(parsed).toMatchObject({
      intent: "Agregar login",
      tags: ["auth", "ui"],
      dependsOn: [otherId],
    });
  });

  it.each([
    ["prioridad negativa", { priority: -1 }],
    ["prioridad no entera", { priority: 1.5 }],
    ["prioridad mayor que MAX_SAFE_INTEGER", { priority: Number.MAX_SAFE_INTEGER + 1 }],
    ["intent vacío", { intent: "   " }],
    ["tag vacía", { tags: [""] }],
    ["projectId que no es uuid", { projectId: "p1" }],
    ["dependencia que no es uuid", { dependsOn: ["t1"] }],
    ["causedBy que no es uuid", { causedBy: "t1" }],
    ["campo desconocido", { state: "completed" }],
  ])("rechaza %s", (_, override) => {
    expect(TaskCreate.safeParse({ ...validCreate, ...override }).success).toBe(false);
  });

  it("acepta la prioridad 0 y MAX_SAFE_INTEGER", () => {
    expect(TaskCreate.safeParse({ ...validCreate, priority: 0 }).success).toBe(true);
    expect(
      TaskCreate.safeParse({ ...validCreate, priority: Number.MAX_SAFE_INTEGER }).success,
    ).toBe(true);
  });
});

describe("TaskUpdate", () => {
  it("acepta un subconjunto de intent, tags y prioridad", () => {
    expect(TaskUpdate.parse({ priority: 900 })).toEqual({ priority: 900 });
    expect(TaskUpdate.parse({})).toEqual({});
  });

  it("no permite cambiar estado, proyecto ni campos de solo lectura", () => {
    for (const field of ["state", "projectId", "riskLabel", "prUrl"]) {
      expect(TaskUpdate.safeParse({ [field]: "x" }).success).toBe(false);
    }
  });
});

describe("TaskCancel", () => {
  it("acepta una nota opcional de hasta 2000 caracteres", () => {
    expect(TaskCancel.parse({})).toEqual({});
    expect(TaskCancel.parse({ note: "ya no aplica" })).toEqual({ note: "ya no aplica" });
    expect(TaskCancel.safeParse({ note: "x".repeat(2001) }).success).toBe(false);
    expect(TaskCancel.safeParse({ note: "" }).success).toBe(false);
  });
});

describe("Task", () => {
  const now = new Date();
  const row = {
    id: otherId,
    projectId,
    intent: "Agregar login",
    tags: [],
    priority: 100,
    state: "draft",
    subState: "queued",
    verificationIteration: 0,
    branch: null,
    worktreePath: null,
    prUrl: null,
    prState: null,
    riskLabel: null,
    causedBy: null,
    createdAt: now,
    updatedAt: now,
  };

  it("acepta una fila completa", () => {
    expect(Task.parse(row)).toEqual(row);
  });

  it("rechaza un estado fuera del enum", () => {
    expect(Task.safeParse({ ...row, state: "new" }).success).toBe(false);
  });
});

describe("DependencyLink", () => {
  it("describe la otra tarea de la arista y si cruza proyectos", () => {
    const link = {
      taskId: otherId,
      projectId,
      intent: "Base",
      state: "completed",
      prState: "merged",
      crossProject: true,
      createdAt: new Date(),
    };
    expect(DependencyLink.parse(link)).toEqual(link);
  });
});

describe("eventos de tareas", () => {
  it("tienen nombres estables", () => {
    expect([TASK_CREATED, TASK_UPDATED, TASK_DEPENDENCY_ADDED, TASK_DEPENDENCY_REMOVED]).toEqual([
      "task.created",
      "task.updated",
      "task.dependency_added",
      "task.dependency_removed",
    ]);
  });

  it("task.created registra lo capturado al crear", () => {
    const payload = {
      projectId,
      intent: "Agregar login",
      tags: ["auth"],
      priority: 100,
      causedBy: null,
      dependsOn: [{ dependsOnId: otherId, crossProject: true }],
    };
    expect(TaskCreatedPayload.parse(payload)).toEqual(payload);
  });

  it("task.updated registra solo los campos que cambiaron, antes y después", () => {
    const payload = { from: { priority: 100 }, to: { priority: 900 } };
    expect(TaskUpdatedPayload.parse(payload)).toEqual(payload);
    expect(TaskUpdatedPayload.safeParse({ from: {}, to: {} }).success).toBe(false);
  });

  it("las aristas registran la dependencia y si cruza proyectos", () => {
    const payload = { dependsOnId: otherId, crossProject: false };
    expect(TaskDependencyPayload.parse(payload)).toEqual(payload);
  });
});

describe("TaskListQuery", () => {
  it("acepta filtros opcionales por proyecto y estado", () => {
    expect(TaskListQuery.parse({})).toEqual({});
    expect(TaskListQuery.parse({ projectId, state: "draft" })).toEqual({
      projectId,
      state: "draft",
    });
    expect(TaskListQuery.safeParse({ state: "nuevo" }).success).toBe(false);
    expect(TaskListQuery.safeParse({ orden: "x" }).success).toBe(false);
  });
});
