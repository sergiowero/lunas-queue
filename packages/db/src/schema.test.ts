import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { migrateDatabase, migrationsFolder } from "./client.ts";
import {
  events,
  outbox,
  projects,
  questions,
  specs,
  taskDependencies,
  tasks,
  usageRecords,
} from "./schema.ts";
import {
  freshDatabase,
  insertProject,
  insertRun,
  insertTask,
  migratedDatabase,
} from "./test-helpers.ts";

const CHECK = /CHECK constraint failed/;
const UNIQUE = /UNIQUE constraint failed/;
const FK = /FOREIGN KEY constraint failed/;
const NOT_NULL = /NOT NULL constraint failed/;

/**
 * Inserts a task and a Run with direct SQL into a database migrated only up to a certain migration:
 * Drizzle inserts all the columns of the current schema and the later migrations do not
 * exist yet.
 */
function rawTaskWithRun(db: ReturnType<typeof freshDatabase>["db"], projectId: string) {
  db.$client
    .prepare(
      "insert into tasks (id, project_id, intent, priority, state, sub_state) values ('t1', ?, 'x', 1, 'in_progress', 'running')",
    )
    .run(projectId);
  db.$client
    .prepare(
      "insert into runs (id, task_id, phase, agent_kind, run_token) values ('r1', 't1', 'implement', 'claude', 'tok')",
    )
    .run();
  const number = db.$client.prepare("select number from tasks where id = 't1'").pluck().get();
  return { id: "t1", number: number as number };
}

describe("projects", () => {
  it("generates id, timestamps and configuration defaults", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.createdAt).toBeInstanceOf(Date);
    expect(p.agentProfiles).toEqual({});
    expect(p.limits).toEqual({});
  });

  it("name and local_path are unique", () => {
    const db = migratedDatabase();
    insertProject(db, { name: "lunas", localPath: "/repos/lunas" });
    expect(() => insertProject(db, { name: "lunas" })).toThrow(UNIQUE);
    expect(() => insertProject(db, { localPath: "/repos/lunas" })).toThrow(UNIQUE);
  });

  it("a project with tasks cannot be deleted", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    insertTask(db, p.id);
    expect(() => db.delete(projects).where(eq(projects.id, p.id)).run()).toThrow(FK);
  });
});

describe("tasks", () => {
  it("the number migration numbers existing tasks from 1 in creation order", () => {
    // Database with the migrations prior to 0008_task_number: the tasks have no number.
    const previous = mkdtempSync(join(tmpdir(), "lunasq-drizzle-"));
    try {
      cpSync(migrationsFolder, previous, { recursive: true });
      const journalFile = join(previous, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalFile, "utf8"));
      journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0008");
      writeFileSync(journalFile, JSON.stringify(journal));
      const { db } = freshDatabase();
      migrate(db, { migrationsFolder: previous });
      const p = insertProject(db);
      const raw = db.$client.prepare(
        "insert into tasks (id, project_id, intent, priority, created_at, updated_at) values (?, ?, 'x', 1, ?, 0)",
      );
      // Inserted out of order; two with the same created_at are broken by rowid.
      raw.run("c", p.id, 300);
      raw.run("a", p.id, 100);
      raw.run("b1", p.id, 200);
      raw.run("b2", p.id, 200);

      migrateDatabase(db);

      const numbered = db.$client.prepare("select id, number from tasks order by number").all() as {
        id: string;
        number: number;
      }[];
      expect(numbered).toEqual([
        { id: "a", number: 1 },
        { id: "b1", number: 2 },
        { id: "b2", number: 3 },
        { id: "c", number: 4 },
      ]);
      expect(insertTask(db, p.id).number).toBe(5);
    } finally {
      rmSync(previous, { recursive: true, force: true });
    }
  });

  it("the number migration does not recreate tasks", () => {
    // Recreating the table would cascade-delete Runs, edges and usage.
    const migration = readFileSync(join(migrationsFolder, "0008_task_number.sql"), "utf8");
    expect(migration).not.toMatch(/DROP TABLE/);
  });

  it("the paused migration recreates tasks keeping rows, Runs, number and triggers", () => {
    // Database with the migrations prior to 0010_task_paused: the state CHECK does not accept paused.
    const previous = mkdtempSync(join(tmpdir(), "lunasq-drizzle-"));
    try {
      cpSync(migrationsFolder, previous, { recursive: true });
      const journalFile = join(previous, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalFile, "utf8"));
      journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0010");
      writeFileSync(journalFile, JSON.stringify(journal));
      const { db } = freshDatabase();
      migrate(db, { migrationsFolder: previous });
      const p = insertProject(db);
      const t = rawTaskWithRun(db, p.id);
      const numberBefore = t.number;
      const insertPaused = db.$client.prepare(
        "insert into tasks (id, project_id, intent, priority, state, sub_state) values (?, ?, 'x', 1, 'paused', null)",
      );
      expect(() => insertPaused.run("pausada-0", p.id)).toThrow(CHECK);

      migrateDatabase(db);

      expect(db.select().from(tasks).where(eq(tasks.id, t.id)).get()).toMatchObject({
        state: "in_progress",
        subState: "running",
        number: numberBefore,
      });
      expect(db.$client.prepare("select count(*) from runs").pluck().get()).toBe(1);
      // Without the migration the CHECK rejects paused: the assertion fails here, not with a loose error.
      let paused: ReturnType<typeof insertTask> | undefined;
      expect(() => {
        paused = insertTask(db, p.id, { state: "paused", subState: null });
      }).not.toThrow();
      expect(paused?.state).toBe("paused");
      // The tasks triggers are recreated: the number is assigned and does not change.
      expect(paused?.number).toBe((numberBefore ?? 0) + 1);
      expect(() => db.update(tasks).set({ number: 99 }).where(eq(tasks.id, t.id)).run()).toThrow(
        /el número de una tarea no cambia/,
      );
      expect(() => insertTask(db, p.id, { state: "otro" as never })).toThrow(CHECK);
      expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.$client.pragma("foreign_key_check")).toEqual([]);
      expect(db.$client.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      rmSync(previous, { recursive: true, force: true });
    }
  });

  it("the Result migration recreates tasks keeping rows, Runs, number and triggers", () => {
    // Database with the migrations prior to 0012_task_result: tasks has no result_kind or result.
    const previous = mkdtempSync(join(tmpdir(), "lunasq-drizzle-"));
    try {
      cpSync(migrationsFolder, previous, { recursive: true });
      const journalFile = join(previous, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalFile, "utf8"));
      journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0012");
      writeFileSync(journalFile, JSON.stringify(journal));
      const { db } = freshDatabase();
      migrate(db, { migrationsFolder: previous });
      const p = insertProject(db);
      const t = rawTaskWithRun(db, p.id);

      migrateDatabase(db);

      const migrated = db.select().from(tasks).where(eq(tasks.id, t.id)).get();
      expect(migrated).toMatchObject({
        state: "in_progress",
        number: t.number,
        resultKind: null,
        result: null,
      });
      expect(db.$client.prepare("select count(*) from runs").pluck().get()).toBe(1);
      // The tasks triggers are recreated: the number is assigned and does not change.
      expect(insertTask(db, p.id).number).toBe((t.number ?? 0) + 1);
      expect(() => db.update(tasks).set({ number: 99 }).where(eq(tasks.id, t.id)).run()).toThrow(
        /el número de una tarea no cambia/,
      );
      expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    } finally {
      rmSync(previous, { recursive: true, force: true });
    }
  });

  it("result_kind only accepts enum values and result stores the text", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const task = insertTask(db, p.id, {
      state: "completed",
      subState: null,
      resultKind: "not_resolvable",
      result: "# Sin resolución",
    });
    expect(task).toMatchObject({ resultKind: "not_resolvable", result: "# Sin resolución" });
    expect(() => insertTask(db, p.id, { resultKind: "otro" as never })).toThrow(CHECK);
  });

  it("number: positive and unique integer, assigned if the insert does not bring it", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    expect(insertTask(db, p.id).number).toBe(1);
    expect(insertTask(db, p.id, { number: 10 }).number).toBe(10);
    expect(insertTask(db, p.id).number).toBe(11);
    expect(() => insertTask(db, p.id, { number: 10 })).toThrow(UNIQUE);
    expect(() => insertTask(db, p.id, { number: 0 })).toThrow(CHECK);
  });

  it("is born in draft/queued with iteration 0", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    expect(t.state).toBe("draft");
    expect(t.subState).toBe("queued");
    expect(t.verificationIteration).toBe(0);
    expect(t.tags).toEqual([]);
  });

  it("priority is an unsigned integer: accepts 0 and large integers", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    expect(insertTask(db, p.id, { priority: 0 }).priority).toBe(0);
    expect(insertTask(db, p.id, { priority: 2 ** 31 }).priority).toBe(2 ** 31);
  });

  it("priority does not exceed Number.MAX_SAFE_INTEGER", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    expect(insertTask(db, p.id, { priority: Number.MAX_SAFE_INTEGER }).priority).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() =>
      db.$client
        .prepare(
          "insert into tasks (id, project_id, intent, priority) values ('big', ?, 'x', 9007199254740992)",
        )
        .run(p.id),
    ).toThrow(CHECK);
  });

  it("priority rejects negatives, non-integers and NULL", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    expect(() => insertTask(db, p.id, { priority: -1 })).toThrow(CHECK);
    expect(() => insertTask(db, p.id, { priority: 1.5 })).toThrow(CHECK);
    const raw = db.$client.prepare(
      "insert into tasks (id, project_id, intent, priority, created_at, updated_at) values (?, ?, 'x', ?, 0, 0)",
    );
    expect(() => raw.run("t-text", p.id, "cien")).toThrow(CHECK);
    expect(() => raw.run("t-null", p.id, null)).toThrow(NOT_NULL);
  });

  it("state, sub-state, PR and risk only accept enum values", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const set = (col: string, value: string) =>
      db.$client.prepare(`update tasks set ${col} = ? where id = ?`).run(value, t.id);
    expect(() => set("state", "new")).toThrow(CHECK);
    expect(() => set("sub_state", "sleeping")).toThrow(CHECK);
    expect(() => set("pr_state", "draft")).toThrow(CHECK);
    expect(() => set("risk_label", "critical")).toThrow(CHECK);
    expect(() => set("state", "in_progress")).not.toThrow();
  });

  it("verification iteration cannot be negative", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    expect(() => insertTask(db, p.id, { verificationIteration: -1 })).toThrow(CHECK);
  });

  it("project_id must exist", () => {
    const db = migratedDatabase();
    expect(() => insertTask(db, "no-existe")).toThrow(FK);
  });

  it("caused_by points to another task and stays NULL if that one is deleted", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const origin = insertTask(db, p.id);
    const fix = insertTask(db, p.id, { causedBy: origin.id });
    expect(() => insertTask(db, p.id, { causedBy: "no-existe" })).toThrow(FK);
    db.delete(tasks).where(eq(tasks.id, origin.id)).run();
    expect(db.select().from(tasks).where(eq(tasks.id, fix.id)).get()?.causedBy).toBeNull();
  });
});

describe("task_dependencies", () => {
  it("the edge is unique and does not allow self-loops", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const a = insertTask(db, p.id);
    const b = insertTask(db, p.id);
    db.insert(taskDependencies).values({ taskId: a.id, dependsOnId: b.id }).run();
    expect(() =>
      db.insert(taskDependencies).values({ taskId: a.id, dependsOnId: b.id }).run(),
    ).toThrow(UNIQUE);
    expect(() =>
      db.insert(taskDependencies).values({ taskId: a.id, dependsOnId: a.id }).run(),
    ).toThrow(CHECK);
  });

  it("both ends must exist and the edge is deleted with either of them", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const a = insertTask(db, p.id);
    const b = insertTask(db, p.id);
    const c = insertTask(db, p.id);
    expect(() =>
      db.insert(taskDependencies).values({ taskId: a.id, dependsOnId: "x" }).run(),
    ).toThrow(FK);
    db.insert(taskDependencies)
      .values([
        { taskId: a.id, dependsOnId: b.id },
        { taskId: c.id, dependsOnId: a.id },
      ])
      .run();
    db.delete(tasks).where(eq(tasks.id, a.id)).run();
    expect(db.select().from(taskDependencies).all()).toEqual([]);
  });
});

describe("specs", () => {
  const criterion = {
    id: "AC-1",
    given: "two tasks that depend on each other",
    when: "the edge that closes the cycle is added",
    outcome: "the edge is rejected",
  };

  it("a single version per task, starting at pending", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const t = insertTask(db, p.id);
    const other = insertTask(db, p.id);
    const [v1] = db
      .insert(specs)
      .values({
        taskId: t.id,
        version: 1,
        acceptanceCriteria: [criterion],
      })
      .returning()
      .all();
    expect(v1?.approval).toBe("pending");
    expect(v1?.createdBy).toBe("agent");
    expect(v1?.acceptanceCriteria).toEqual([criterion]);
    db.insert(specs).values({ taskId: t.id, version: 2 }).run();
    db.insert(specs).values({ taskId: other.id, version: 1 }).run();
    expect(() => db.insert(specs).values({ taskId: t.id, version: 1 }).run()).toThrow(UNIQUE);
  });

  it("a single approved version per task", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const t = insertTask(db, p.id);
    const other = insertTask(db, p.id);
    db.insert(specs).values({ taskId: t.id, version: 1, approval: "approved" }).run();
    db.insert(specs).values({ taskId: t.id, version: 2, approval: "changes_requested" }).run();
    db.insert(specs).values({ taskId: other.id, version: 1, approval: "approved" }).run();
    expect(() =>
      db.insert(specs).values({ taskId: t.id, version: 3, approval: "approved" }).run(),
    ).toThrow(UNIQUE);
  });

  it("author from the actors enum", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    expect(() =>
      db.$client
        .prepare(
          "insert into specs (id, task_id, version, created_by, created_at) values ('s', ?, 1, 'robot', 0)",
        )
        .run(t.id),
    ).toThrow(CHECK);
  });

  it("positive version and approval from the enum", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    expect(() => db.insert(specs).values({ taskId: t.id, version: 0 }).run()).toThrow(CHECK);
    expect(() =>
      db.$client
        .prepare(
          "insert into specs (id, task_id, version, approval, created_at) values ('s', ?, 1, 'maybe', 0)",
        )
        .run(t.id),
    ).toThrow(CHECK);
  });
});

describe("runs", () => {
  it("stores model and iteration, with iteration 0 by default and non-negative", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const r = insertRun(db, t.id, { model: "claude-opus-5-5" });
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.iteration).toBe(0);
    expect(() => insertRun(db, t.id, { iteration: -1 })).toThrow(CHECK);
    expect(() => insertRun(db, t.id, { iteration: 0.5 })).toThrow(CHECK);
  });

  it("a task has at most one active Run (no ended_at)", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const t = insertTask(db, p.id);
    const first = insertRun(db, t.id);
    expect(() => insertRun(db, t.id)).toThrow(UNIQUE);
    insertRun(db, insertTask(db, p.id).id);
    db.$client
      .prepare("update runs set ended_at = 1, result = 'failure' where id = ?")
      .run(first.id);
    expect(() => insertRun(db, t.id)).not.toThrow();
  });

  it("run_token is unique", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    insertRun(db, t.id, { runToken: "abc" });
    expect(() => insertRun(db, t.id, { runToken: "abc" })).toThrow(UNIQUE);
  });

  it("phase, agent type and result only accept enum values", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const r = insertRun(db, t.id);
    const set = (col: string, value: string) =>
      db.$client.prepare(`update runs set ${col} = ? where id = ?`).run(value, r.id);
    expect(() => set("phase", "deploy")).toThrow(CHECK);
    expect(() => set("agent_kind", "codex")).toThrow(CHECK);
    expect(() => set("result", "ok")).toThrow(CHECK);
    expect(() => set("result", "failure")).not.toThrow();
    expect(() => set("agent_session_source", "otra")).toThrow(CHECK);
    expect(() => set("agent_session_source", "native")).not.toThrow();
  });

  it("the dispatcher migration keeps the Runs and their usage", () => {
    // The new columns come in with ADD COLUMN: recreating `runs` would cascade-delete usage.
    const db = migratedDatabase();
    const r = insertRun(db, insertTask(db, insertProject(db).id).id);
    expect(r.agentSessionSource).toBeNull();
    expect(r.launchedAt).toBeNull();
    const migration = readFileSync(join(migrationsFolder, "0004_dispatcher.sql"), "utf8");
    expect(migration).not.toMatch(/DROP TABLE/);
  });

  it("stores handoff as JSON and requires an existing task", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const r = insertRun(db, t.id, { handoff: { summary: "listo", tests: ["a.test.ts"] } });
    expect(r.handoff).toEqual({ summary: "listo", tests: ["a.test.ts"] });
    expect(() => insertRun(db, "no-existe")).toThrow(FK);
  });
});

describe("questions", () => {
  it("is born open, run_id stays NULL if the Run is deleted", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const r = insertRun(db, t.id);
    const [q] = db
      .insert(questions)
      .values({ taskId: t.id, runId: r.id, question: "¿Postgres o SQLite?" })
      .returning()
      .all();
    expect(q?.status).toBe("open");
    db.$client.prepare("delete from runs where id = ?").run(r.id);
    expect(db.select().from(questions).get()?.runId).toBeNull();
  });

  it("enum state and existing keys", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    expect(() => db.insert(questions).values({ taskId: "x", question: "?" }).run()).toThrow(FK);
    expect(() =>
      db.insert(questions).values({ taskId: t.id, runId: "x", question: "?" }).run(),
    ).toThrow(FK);
    expect(() =>
      db.$client
        .prepare(
          "insert into questions (id, task_id, question, status, created_at) values ('q', ?, '?', 'pending', 0)",
        )
        .run(t.id),
    ).toThrow(CHECK);
  });
});

describe("usage_records", () => {
  it("belongs to a Run, with non-negative tokens and enum source", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const r = insertRun(db, t.id);
    const base = { runId: r.id, model: "claude-opus-5-5", source: "otel" as const };
    const [u] = db
      .insert(usageRecords)
      .values({ ...base, inputTokens: 10, outputTokens: 5, costUsd: 0.12 })
      .returning()
      .all();
    expect(u?.cacheReadTokens).toBe(0);
    expect(() =>
      db
        .insert(usageRecords)
        .values({ ...base, runId: "x" })
        .run(),
    ).toThrow(FK);
    expect(() =>
      db
        .insert(usageRecords)
        .values({ ...base, outputTokens: -1 })
        .run(),
    ).toThrow(CHECK);
    expect(() =>
      db
        .insert(usageRecords)
        .values({ ...base, costUsd: -0.01 })
        .run(),
    ).toThrow(CHECK);
    expect(() =>
      db
        .insert(usageRecords)
        .values({ ...base, inputTokens: 1.5 })
        .run(),
    ).toThrow(CHECK);
    expect(() =>
      db.$client
        .prepare(
          "insert into usage_records (id, run_id, model, source, created_at) values ('u', ?, 'm', 'guess', 0)",
        )
        .run(r.id),
    ).toThrow(CHECK);
  });
});

describe("usage_records: deduplication", () => {
  it("source_ref is unique per Run and source; without source_ref it is not deduplicated", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const r = insertRun(db, t.id);
    const base = { runId: r.id, model: "m", source: "otel" as const };
    db.insert(usageRecords)
      .values({ ...base, sourceRef: "msg-1" })
      .run();
    expect(() =>
      db
        .insert(usageRecords)
        .values({ ...base, sourceRef: "msg-1" })
        .run(),
    ).toThrow(UNIQUE);
    db.insert(usageRecords)
      .values({ ...base, source: "transcript", sourceRef: "msg-1" })
      .run();
    db.insert(usageRecords).values(base).run();
    db.insert(usageRecords).values(base).run();
    expect(db.select().from(usageRecords).all()).toHaveLength(4);
  });
});

describe("events and outbox", () => {
  it("events with increasing id, enum actor and JSON payload", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const [e1] = db
      .insert(events)
      .values({ taskId: t.id, type: "task.created", actor: "human", payload: { intent: "x" } })
      .returning()
      .all();
    const [e2] = db
      .insert(events)
      .values({ taskId: t.id, type: "task.refined", actor: "agent" })
      .returning()
      .all();
    expect(e1?.payload).toEqual({ intent: "x" });
    expect(e2?.id).toBeGreaterThan(e1?.id ?? Number.POSITIVE_INFINITY);
    expect(() =>
      db.insert(events).values({ taskId: "x", type: "t", actor: "system" }).run(),
    ).toThrow(FK);
    expect(() =>
      db.$client
        .prepare(
          "insert into events (task_id, type, actor, created_at) values (?, 't', 'robot', 0)",
        )
        .run(t.id),
    ).toThrow(CHECK);
  });

  it("a single outbox message per event, pending until published", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const [e] = db
      .insert(events)
      .values({ taskId: t.id, type: "task.created", actor: "human" })
      .returning()
      .all();
    if (!e) throw new Error("no event");
    const [m] = db
      .insert(outbox)
      .values({ eventId: e.id, topic: "task.state_changed" })
      .returning()
      .all();
    expect(m?.publishedAt).toBeNull();
    expect(m?.attempts).toBe(0);
    expect(() => db.insert(outbox).values({ eventId: e.id, topic: "otro" }).run()).toThrow(UNIQUE);
    expect(() => db.insert(outbox).values({ eventId: 9999, topic: "x" }).run()).toThrow(FK);
  });
});

describe("deleting a task", () => {
  it("takes specs, runs, questions, usage and edges with it when it has no events", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const t = insertTask(db, p.id);
    const other = insertTask(db, p.id);
    const r = insertRun(db, t.id);
    db.insert(specs).values({ taskId: t.id, version: 1 }).run();
    db.insert(questions).values({ taskId: t.id, runId: r.id, question: "?" }).run();
    db.insert(usageRecords).values({ runId: r.id, model: "m", source: "otel" }).run();
    db.insert(taskDependencies).values({ taskId: other.id, dependsOnId: t.id }).run();

    db.delete(tasks).where(eq(tasks.id, t.id)).run();

    for (const table of [specs, questions, usageRecords, taskDependencies]) {
      expect(db.select().from(table).all()).toEqual([]);
    }
    expect(db.$client.prepare("select count(*) from runs").pluck().get()).toBe(0);
  });

  it("the Event log is append-only: a task with events cannot be deleted", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    db.insert(events).values({ taskId: t.id, type: "task.created", actor: "human" }).run();
    expect(() => db.delete(tasks).where(eq(tasks.id, t.id)).run()).toThrow(FK);
    expect(db.select().from(events).all()).toHaveLength(1);
  });
});
