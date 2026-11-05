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
  it("accepts the minimum and fills in empty tags and dependencies", () => {
    expect(TaskCreate.parse(validCreate)).toEqual({ ...validCreate, tags: [], dependsOn: [] });
  });

  it("trims the intent and the tags and removes duplicates", () => {
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
    ["negative priority", { priority: -1 }],
    ["non-integer priority", { priority: 1.5 }],
    ["priority greater than MAX_SAFE_INTEGER", { priority: Number.MAX_SAFE_INTEGER + 1 }],
    ["empty intent", { intent: "   " }],
    ["empty tag", { tags: [""] }],
    ["projectId that is not a uuid", { projectId: "p1" }],
    ["dependency that is not a uuid", { dependsOn: ["t1"] }],
    ["causedBy that is not a uuid", { causedBy: "t1" }],
    ["unknown field", { state: "completed" }],
  ])("rejects %s", (_, override) => {
    expect(TaskCreate.safeParse({ ...validCreate, ...override }).success).toBe(false);
  });

  it("accepts priority 0 and MAX_SAFE_INTEGER", () => {
    expect(TaskCreate.safeParse({ ...validCreate, priority: 0 }).success).toBe(true);
    expect(
      TaskCreate.safeParse({ ...validCreate, priority: Number.MAX_SAFE_INTEGER }).success,
    ).toBe(true);
  });
});

describe("TaskUpdate", () => {
  it("accepts a subset of intent, tags and priority", () => {
    expect(TaskUpdate.parse({ priority: 900 })).toEqual({ priority: 900 });
    expect(TaskUpdate.parse({})).toEqual({});
  });

  it("does not allow changing the state, project or read-only fields", () => {
    for (const field of ["state", "projectId", "riskLabel", "prUrl"]) {
      expect(TaskUpdate.safeParse({ [field]: "x" }).success).toBe(false);
    }
  });
});

describe("TaskCancel", () => {
  it("accepts an optional note of up to 2000 characters", () => {
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
    number: 7,
    projectId,
    intent: "Agregar login",
    title: null,
    tags: [],
    priority: 100,
    state: "draft",
    subState: "queued",
    verificationIteration: 0,
    verificationCycleStart: 0,
    branch: null,
    worktreePath: null,
    prUrl: null,
    prState: null,
    riskLabel: null,
    resultKind: null,
    result: null,
    causedBy: null,
    createdAt: now,
    updatedAt: now,
  };

  it("accepts a complete row", () => {
    expect(Task.parse(row)).toEqual(row);
  });

  it("requires a positive integer task number", () => {
    const { number: _, ...withoutNumber } = row;
    expect(Task.safeParse(withoutNumber).success).toBe(false);
    expect(Task.safeParse({ ...row, number: 0 }).success).toBe(false);
    expect(Task.safeParse({ ...row, number: 1.5 }).success).toBe(false);
  });

  it("a task completed with a Result carries its type and its text", () => {
    const withResult = {
      ...row,
      state: "completed",
      subState: null,
      resultKind: "research",
      result: "# Hallazgos",
    };
    expect(Task.parse(withResult)).toEqual(withResult);
  });

  it("requires resultKind and result (null if the task has no Result)", () => {
    const { resultKind: _k, ...withoutKind } = row;
    const { result: _r, ...withoutResult } = row;
    expect(Task.safeParse(withoutKind).success).toBe(false);
    expect(Task.safeParse(withoutResult).success).toBe(false);
    expect(Task.safeParse({ ...row, resultKind: "otro" }).success).toBe(false);
  });

  it("rejects a state outside the enum", () => {
    expect(Task.safeParse({ ...row, state: "new" }).success).toBe(false);
  });
});

describe("DependencyLink", () => {
  it("describes the other task of the edge and whether it crosses projects", () => {
    const link = {
      taskId: otherId,
      number: 3,
      projectId,
      intent: "Base",
      title: "Esquema base",
      state: "completed",
      prState: "merged",
      crossProject: true,
      createdAt: new Date(),
    };
    expect(DependencyLink.parse(link)).toEqual(link);
  });
});

describe("task events", () => {
  it("have stable names", () => {
    expect([TASK_CREATED, TASK_UPDATED, TASK_DEPENDENCY_ADDED, TASK_DEPENDENCY_REMOVED]).toEqual([
      "task.created",
      "task.updated",
      "task.dependency_added",
      "task.dependency_removed",
    ]);
  });

  it("task.created records what was captured on creation", () => {
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

  it("task.updated records only the fields that changed, before and after", () => {
    const payload = { from: { priority: 100 }, to: { priority: 900 } };
    expect(TaskUpdatedPayload.parse(payload)).toEqual(payload);
    expect(TaskUpdatedPayload.safeParse({ from: {}, to: {} }).success).toBe(false);
  });

  it("edges record the dependency and whether it crosses projects", () => {
    const payload = { dependsOnId: otherId, crossProject: false };
    expect(TaskDependencyPayload.parse(payload)).toEqual(payload);
  });
});

describe("TaskListQuery", () => {
  it("accepts optional filters by project and state", () => {
    expect(TaskListQuery.parse({})).toEqual({});
    expect(TaskListQuery.parse({ projectId, state: "draft" })).toEqual({
      projectId,
      state: "draft",
    });
    expect(TaskListQuery.safeParse({ state: "nuevo" }).success).toBe(false);
    expect(TaskListQuery.safeParse({ orden: "x" }).success).toBe(false);
  });
});
