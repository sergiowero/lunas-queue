import {
  SPEC_APPROVED,
  SPEC_CHANGES_REQUESTED,
  SPEC_VERSION_CREATED,
  type SpecContent,
  TASK_TRANSITIONED,
} from "@lunasq/schemas";
import { specContentExample } from "@lunasq/schemas/testing";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { type LunasqDatabase, migrateDatabase } from "./client.ts";
import { listEvents } from "./event-log.ts";
import * as schema from "./schema.ts";
import { outbox, specs, tasks } from "./schema.ts";
import { SpecRepository, type SpecResult } from "./specs.ts";
import { transitionTask } from "./task-transitions.ts";
import { freshDatabase, insertProject, insertTask, migratedDatabase } from "./test-helpers.ts";

const missing = "00000000-0000-4000-8000-000000000999";

function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const repo = new SpecRepository(db);
  // The refiner is running: the task is in draft/running.
  const refining = () => insertTask(db, project.id, { state: "draft", subState: "running" });
  const taskRow = (id: string) => db.select().from(tasks).where(eq(tasks.id, id)).get();
  const eventTypes = (id: string) => listEvents(db, id).map((e) => e.type);
  return { db, repo, refining, taskRow, eventTypes };
}

function ok(result: SpecResult) {
  if (!result.ok) throw new Error(`ok expected: ${result.error.code} ${result.error.message}`);
  return result;
}

function failed(result: SpecResult) {
  if (result.ok) throw new Error("a rejection was expected");
  return result.error;
}

/** Content different from the example, for the following versions. */
function revised(): SpecContent {
  const content = specContentExample();
  content.requirements.push("El cliente recibe un correo al cancelar");
  return content;
}

describe("SpecRepository.submit", () => {
  it("creates version 1 with agent author and moves the task to refined", () => {
    const { db, repo, refining, taskRow, eventTypes } = setup();
    const task = refining();
    const { spec, task: moved } = ok(repo.submit(task.id, specContentExample()));
    expect(spec).toMatchObject({
      taskId: task.id,
      version: 1,
      content: specContentExample(),
      approval: "pending",
      createdBy: "agent",
      approvedBy: null,
      approvedAt: null,
    });
    expect(moved).toMatchObject({ state: "refined", subState: null });
    expect(taskRow(task.id)).toMatchObject({ state: "refined", subState: null });
    expect(eventTypes(task.id)).toEqual([SPEC_VERSION_CREATED, TASK_TRANSITIONED]);
    const [created] = listEvents(db, task.id);
    expect(created).toMatchObject({
      actor: "agent",
      payload: { specId: spec.id, version: 1, basedOn: null },
    });
  });

  it("persists the approved documentation deliverable through the database", () => {
    const { repo, refining } = setup();
    const task = refining();
    const content = { ...specContentExample(), deliverable: "docs" as const };

    const submitted = ok(repo.submit(task.id, content));

    expect(submitted.spec.content.deliverable).toBe("docs");
    expect(repo.get(task.id, submitted.spec.version)?.content.deliverable).toBe("docs");
  });

  it("numbers the versions of each task in order", () => {
    const { db, repo, refining } = setup();
    const task = refining();
    const other = refining();
    ok(repo.submit(task.id, specContentExample()));
    ok(repo.requestChanges(task.id, 1, "Falta el caso de pedido enviado"));
    // The reconciliation dispatches the refiner again.
    setRunning(db, task.id);
    expect(ok(repo.submit(task.id, revised())).spec.version).toBe(2);
    expect(ok(repo.submit(other.id, specContentExample())).spec.version).toBe(1);
    expect(repo.list(task.id)?.map((s) => s.version)).toEqual([1, 2]);
  });

  it("validates the content before writing", () => {
    const { db, repo, refining } = setup();
    const task = refining();
    expect(() => repo.submit(task.id, { ...specContentExample(), criteria: [] })).toThrow(
      expect.objectContaining({ name: "ZodError" }),
    );
    expect(db.select().from(specs).all()).toEqual([]);
  });

  it("if the transition is rejected, no version or event is left", () => {
    const { db, repo, eventTypes } = setup();
    const project = insertProject(db);
    const queued = insertTask(db, project.id, { state: "draft", subState: "queued" });
    expect(failed(repo.submit(queued.id, specContentExample())).code).toBe("invalid_transition");
    expect(db.select().from(specs).all()).toEqual([]);
    expect(eventTypes(queued.id)).toEqual([]);
  });

  it("nonexistent task", () => {
    const { repo } = setup();
    expect(failed(repo.submit(missing, specContentExample())).code).toBe("task_not_found");
  });
});

describe("SpecRepository.approve", () => {
  function submitted() {
    const ctx = setup();
    const task = ctx.refining();
    ok(ctx.repo.submit(task.id, specContentExample()));
    return { ...ctx, task };
  }

  it("ties the approval to the exact version and moves the task to in_progress/queued", () => {
    const { db, repo, task, taskRow, eventTypes } = submitted();
    const { spec } = ok(repo.approve(task.id, 1));
    expect(spec).toMatchObject({ version: 1, approval: "approved", approvedBy: "human" });
    expect(spec.approvedAt).toBeInstanceOf(Date);
    expect(taskRow(task.id)).toMatchObject({ state: "in_progress", subState: "queued" });
    expect(repo.approved(task.id)).toEqual(spec);
    expect(eventTypes(task.id).slice(-2)).toEqual([SPEC_APPROVED, TASK_TRANSITIONED]);
    const approvedEvent = listEvents(db, task.id).at(-2);
    expect(approvedEvent).toMatchObject({
      actor: "human",
      payload: { specId: spec.id, version: 1 },
    });
  });

  it("only the latest version is approved: an old one answers stale_version without writing", () => {
    const { db, repo, task, taskRow, eventTypes } = submitted();
    ok(repo.requestChanges(task.id, 1, "Falta el caso de pedido enviado"));
    setRunning(db, task.id);
    ok(repo.submit(task.id, revised()));
    const before = eventTypes(task.id);
    expect(failed(repo.approve(task.id, 1)).code).toBe("stale_version");
    expect(taskRow(task.id)).toMatchObject({ state: "refined" });
    expect(repo.get(task.id, 1)?.approval).toBe("changes_requested");
    expect(eventTypes(task.id)).toEqual(before);
    expect(repo.approved(task.id)).toBeNull();
    expect(ok(repo.approve(task.id, 2)).spec.version).toBe(2);
    expect(repo.approved(task.id)?.content).toEqual(revised());
  });

  it("repeating the approval does not duplicate effects", () => {
    const { repo, task, eventTypes } = submitted();
    ok(repo.approve(task.id, 1));
    const before = eventTypes(task.id);
    expect(failed(repo.approve(task.id, 1)).code).toBe("spec_not_pending");
    expect(eventTypes(task.id)).toEqual(before);
  });

  it("if the transition is rejected the spec stays pending", () => {
    const { db, repo, task } = submitted();
    // Another process canceled the task while the human was reviewing.
    db.update(tasks).set({ state: "cancelled", subState: null }).where(eq(tasks.id, task.id)).run();
    expect(failed(repo.approve(task.id, 1)).code).toBe("invalid_transition");
    expect(repo.get(task.id, 1)).toMatchObject({ approval: "pending", approvedAt: null });
    expect(repo.approved(task.id)).toBeNull();
  });

  it("nonexistent version or task", () => {
    const { repo, task } = submitted();
    expect(failed(repo.approve(task.id, 7)).code).toBe("spec_not_found");
    expect(failed(repo.approve(missing, 1)).code).toBe("task_not_found");
  });
});

describe("SpecRepository.requestChanges", () => {
  it("sends the task back to draft/queued with the comments in the version and in the event", () => {
    const { db, repo, refining, taskRow, eventTypes } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    const { spec, task: moved } = ok(
      repo.requestChanges(task.id, 1, "  Falta el caso de pedido enviado  "),
    );
    expect(spec).toMatchObject({
      version: 1,
      approval: "changes_requested",
      reviewComments: "Falta el caso de pedido enviado",
    });
    expect(moved).toMatchObject({ state: "draft", subState: "queued" });
    expect(taskRow(task.id)).toMatchObject({ state: "draft", subState: "queued" });
    expect(eventTypes(task.id).slice(-2)).toEqual([SPEC_CHANGES_REQUESTED, TASK_TRANSITIONED]);
    expect(listEvents(db, task.id).at(-2)).toMatchObject({
      actor: "human",
      payload: { specId: spec.id, version: 1, comments: "Falta el caso de pedido enviado" },
    });
    // The state change goes out through the outbox to the scheduler and dispatcher.
    expect(db.select().from(outbox).all()).toHaveLength(2);
  });

  it("without comments it is rejected without writing", () => {
    const { repo, refining, taskRow } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    const error = failed(repo.requestChanges(task.id, 1, "   "));
    expect(error.code).toBe("guard_failed");
    expect(repo.get(task.id, 1)).toMatchObject({ approval: "pending", reviewComments: null });
    expect(taskRow(task.id)).toMatchObject({ state: "refined" });
  });

  it("does not apply to an already approved version", () => {
    const { repo, refining } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    ok(repo.approve(task.id, 1));
    expect(failed(repo.requestChanges(task.id, 1, "tarde")).code).toBe("spec_not_pending");
  });
});

describe("SpecRepository.editAndApprove", () => {
  it("creates the next version with human author and approves it in one step", () => {
    const { db, repo, refining, taskRow, eventTypes } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    const { spec } = ok(repo.editAndApprove(task.id, 1, revised()));
    expect(spec).toMatchObject({
      version: 2,
      content: revised(),
      createdBy: "human",
      approval: "approved",
      approvedBy: "human",
    });
    expect(repo.approved(task.id)?.version).toBe(2);
    expect(repo.get(task.id, 1)?.approval).toBe("pending");
    expect(taskRow(task.id)).toMatchObject({ state: "in_progress", subState: "queued" });
    expect(eventTypes(task.id).slice(-3)).toEqual([
      SPEC_VERSION_CREATED,
      SPEC_APPROVED,
      TASK_TRANSITIONED,
    ]);
    expect(listEvents(db, task.id).at(-3)).toMatchObject({
      actor: "human",
      payload: { specId: spec.id, version: 2, basedOn: 1 },
    });
  });

  it("starts from the latest pending version", () => {
    const { db, repo, refining } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    ok(repo.requestChanges(task.id, 1, "otra ronda"));
    setRunning(db, task.id);
    ok(repo.submit(task.id, revised()));
    expect(failed(repo.editAndApprove(task.id, 1, revised())).code).toBe("stale_version");
    expect(db.select().from(specs).all()).toHaveLength(2);
  });

  it("if the transition is rejected, the edited version is not left", () => {
    const { db, repo, refining } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    db.update(tasks).set({ state: "cancelled", subState: null }).where(eq(tasks.id, task.id)).run();
    expect(failed(repo.editAndApprove(task.id, 1, revised())).code).toBe("invalid_transition");
    expect(repo.list(task.id)?.map((s) => s.version)).toEqual([1]);
  });

  it("validates the edited content", () => {
    const { repo, refining } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    expect(() =>
      repo.editAndApprove(task.id, 1, { ...revised(), taskList: [] } as SpecContent),
    ).toThrow(expect.objectContaining({ name: "ZodError" }));
  });
});

describe("SpecRepository: concurrency", () => {
  it("writes take the write lock before reading", () => {
    const { db: first, file } = freshDatabase();
    migrateDatabase(first);
    const project = insertProject(first);
    const task = insertTask(first, project.id, { state: "draft", subState: "running" });
    ok(new SpecRepository(first).submit(task.id, specContentExample()));
    // Second connection, like another process's, which logs every query it runs.
    const queries: string[] = [];
    const client = new Database(file);
    client.pragma("busy_timeout = 0");
    const second = drizzle({ client, schema, logger: { logQuery: (q) => queries.push(q) } });
    try {
      first.$client.prepare("BEGIN IMMEDIATE").run();
      // Without IMMEDIATE, two approvals would read the same pending version at once.
      expect(() => new SpecRepository(second).approve(task.id, 1)).toThrow(/locked|busy/i);
      expect(() => new SpecRepository(second).submit(task.id, revised())).toThrow(/locked|busy/i);
      expect(queries).toEqual([]);
      first.$client.prepare("ROLLBACK").run();
      expect(new SpecRepository(second).approve(task.id, 1).ok).toBe(true);
    } finally {
      client.close();
    }
  });
});

describe("SpecRepository: reads and diff", () => {
  it("list and get return null if the task or the version do not exist", () => {
    const { repo, refining } = setup();
    const task = refining();
    expect(repo.list(task.id)).toEqual([]);
    expect(repo.list(missing)).toBeNull();
    expect(repo.get(task.id, 1)).toBeNull();
    expect(repo.approved(task.id)).toBeNull();
  });

  it("diff against the previous version by default, or against the given one", () => {
    const { repo, refining } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    ok(repo.editAndApprove(task.id, 1, revised()));
    const diff = repo.diff(task.id, 2);
    expect(diff).toMatchObject({ from: 1, to: 2, identical: false });
    expect(diff?.changes.requirements.added).toEqual(["El cliente recibe un correo al cancelar"]);
    expect(repo.diff(task.id, 2, 2)).toMatchObject({ from: 2, to: 2, identical: true });
    const first = repo.diff(task.id, 1);
    expect(first).toMatchObject({ from: null, to: 1, identical: false });
    expect(first?.changes.criteria.added).toHaveLength(2);
    expect(repo.diff(task.id, 3)).toBeNull();
    expect(repo.diff(task.id, 2, 9)).toBeNull();
  });
});

// The dispatcher dispatches the refiner again: draft/queued → draft/running.
function setRunning(db: LunasqDatabase, taskId: string) {
  const result = transitionTask(db, { taskId, actor: "system", command: { type: "dispatch" } });
  if (!result.ok) throw new Error(result.error.message);
}
