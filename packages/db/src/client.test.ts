import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { TaskCreatedPayload, TaskUpdatedPayload } from "@lunasq/schemas";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { migrateDatabase, migrationsFolder, openDatabase } from "./client.ts";
import { QuestionRepository } from "./questions.ts";
import { freshDatabase } from "./test-helpers.ts";

const TABLES = [
  "app_settings",
  "events",
  "outbox",
  "projects",
  "questions",
  "run_subagents",
  "runs",
  "specs",
  "task_dependencies",
  "tasks",
  "usage_records",
];

function userTables(db: ReturnType<typeof openDatabase>): string[] {
  return db.$client
    .prepare(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%' order by name",
    )
    .pluck()
    .all() as string[];
}

describe("openDatabase", () => {
  it("opens in WAL with foreign keys active and busy_timeout", () => {
    const { db } = freshDatabase();
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.$client.pragma("busy_timeout", { simple: true })).toBeGreaterThan(0);
  });
});

const PROJECT_UUID = "6f1c1c1e-2b7a-4c58-9d3e-0a1b2c3d4e5f";

describe("migrations", () => {
  it("apply cleanly on an empty database and create all the tables", () => {
    const { db } = freshDatabase();
    expect(userTables(db)).toEqual([]);
    migrateDatabase(db);
    expect(userTables(db)).toEqual(TABLES);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    expect(db.$client.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("are idempotent: applying twice changes nothing", () => {
    const { db, file } = freshDatabase();
    migrateDatabase(db);
    const applied = db.$client.prepare("select count(*) from __drizzle_migrations").pluck().get();
    db.$client.close();

    const reopened = openDatabase(file);
    try {
      expect(() => migrateDatabase(reopened)).not.toThrow();
      expect(
        reopened.$client.prepare("select count(*) from __drizzle_migrations").pluck().get(),
      ).toBe(applied);
      expect(userTables(reopened)).toEqual(TABLES);
    } finally {
      reopened.$client.close();
    }
  });

  it("the settings migration keeps the outbox and events rows of a database already in use", () => {
    const { db } = freshDatabase();
    // Database in the state before migration 0011: the journal is trimmed to the first eleven.
    const previous = mkdtempSync(join(tmpdir(), "lunasq-migrations-"));
    try {
      cpSync(migrationsFolder, previous, { recursive: true });
      const journalFile = join(previous, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalFile, "utf8")) as { entries: unknown[] };
      journal.entries = journal.entries.slice(0, 11);
      writeFileSync(journalFile, JSON.stringify(journal));
      migrate(db, { migrationsFolder: previous });
    } finally {
      rmSync(previous, { recursive: true, force: true });
    }
    const sqlite = db.$client;
    sqlite
      .prepare(
        "insert into projects (id, name, repo, base_branch, local_path) values ('p', 'p', 'o/p', 'main', '/tmp/p')",
      )
      .run();
    sqlite
      .prepare(
        "insert into tasks (id, project_id, number, intent, state, sub_state, priority) values ('t', 'p', 1, 'i', 'draft', 'queued', 0)",
      )
      .run();
    sqlite
      .prepare("insert into events (task_id, type, actor) values ('t', 'task.created', 'system')")
      .run();
    sqlite
      .prepare("insert into outbox (event_id, topic, published_at) values (1, 'task.created', 5)")
      .run();

    migrateDatabase(db);

    expect(sqlite.prepare("select count(*) from events").pluck().get()).toBe(1);
    expect(sqlite.prepare("select event_id, topic, published_at from outbox").all()).toEqual([
      { event_id: 1, topic: "task.created", published_at: 5 },
    ]);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });

  it("the options migration leaves existing questions with null options and answerable", () => {
    const { db } = freshDatabase();
    // Database before migration 0012: the journal is trimmed to the first twelve.
    const previous = mkdtempSync(join(tmpdir(), "lunasq-migrations-"));
    try {
      cpSync(migrationsFolder, previous, { recursive: true });
      const journalFile = join(previous, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalFile, "utf8")) as { entries: unknown[] };
      journal.entries = journal.entries.slice(0, 12);
      writeFileSync(journalFile, JSON.stringify(journal));
      migrate(db, { migrationsFolder: previous });
    } finally {
      rmSync(previous, { recursive: true, force: true });
    }
    const sqlite = db.$client;
    sqlite
      .prepare(
        "insert into projects (id, name, repo, base_branch, local_path) values ('p', 'p', 'o/p', 'main', '/tmp/p')",
      )
      .run();
    sqlite
      .prepare(
        "insert into tasks (id, project_id, number, intent, state, sub_state, priority) values ('t', 'p', 1, 'i', 'in_progress', 'waiting_human', 0)",
      )
      .run();
    sqlite
      .prepare("insert into questions (id, task_id, question) values ('q', 't', '¿Sigo?')")
      .run();

    migrateDatabase(db);

    expect(sqlite.prepare("select options from questions where id = 'q'").pluck().get()).toBeNull();
    expect(
      new QuestionRepository(db).answer("q", { answer: "Sí", agentAlive: true }),
    ).toMatchObject({ ok: true, question: { options: null, answer: "Sí" } });
  });

  it("the goal migration renames the task column and rewrites the stored event payloads", () => {
    const { db } = freshDatabase();
    // Database before migration 0017: the journal is trimmed to the first seventeen.
    const previous = mkdtempSync(join(tmpdir(), "lunasq-migrations-"));
    try {
      cpSync(migrationsFolder, previous, { recursive: true });
      const journalFile = join(previous, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalFile, "utf8")) as { entries: unknown[] };
      journal.entries = journal.entries.slice(0, 17);
      writeFileSync(journalFile, JSON.stringify(journal));
      migrate(db, { migrationsFolder: previous });
    } finally {
      rmSync(previous, { recursive: true, force: true });
    }
    const sqlite = db.$client;
    sqlite
      .prepare(
        "insert into projects (id, name, repo, base_branch, local_path) values ('p', 'p', 'o/p', 'main', '/tmp/p')",
      )
      .run();
    sqlite
      .prepare(
        "insert into tasks (id, project_id, number, intent, state, sub_state, priority) values ('t', 'p', 1, 'Do it', 'draft', 'queued', 0)",
      )
      .run();
    const insertEvent = sqlite.prepare(
      "insert into events (task_id, type, actor, payload) values ('t', ?, 'human', ?)",
    );
    insertEvent.run(
      "task.created",
      JSON.stringify({
        projectId: PROJECT_UUID,
        intent: "Do it",
        tags: [],
        priority: 0,
        causedBy: null,
        dependsOn: [],
      }),
    );
    insertEvent.run(
      "task.updated",
      JSON.stringify({ from: { intent: "Do it" }, to: { intent: "Do more", priority: 3 } }),
    );
    insertEvent.run("task.updated", JSON.stringify({ from: { priority: 0 }, to: { priority: 3 } }));

    migrateDatabase(db);

    const columns = (
      sqlite.prepare("select name from pragma_table_info('tasks')").pluck().all() as string[]
    ).filter((name) => name === "goal" || name === "intent");
    expect(columns).toEqual(["goal"]);
    expect(sqlite.prepare("select goal from tasks where id = 't'").pluck().get()).toBe("Do it");
    const payloads = (
      sqlite.prepare("select payload from events order by id").pluck().all() as string[]
    ).map((p) => JSON.parse(p));
    expect(payloads).toEqual([
      {
        projectId: PROJECT_UUID,
        goal: "Do it",
        tags: [],
        priority: 0,
        causedBy: null,
        dependsOn: [],
      },
      { from: { goal: "Do it" }, to: { goal: "Do more", priority: 3 } },
      { from: { priority: 0 }, to: { priority: 3 } },
    ]);
    expect(() => TaskCreatedPayload.parse(payloads[0])).not.toThrow();
    expect(() => TaskUpdatedPayload.parse(payloads[1])).not.toThrow();
    expect(() => TaskUpdatedPayload.parse(payloads[2])).not.toThrow();
    // The log is still append-only once the migration is done.
    expect(() => sqlite.prepare("update events set payload = null").run()).toThrow(/append-only/);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });

  it("are in sync with the Drizzle schema", () => {
    const out = mkdtempSync(join(tmpdir(), "lunasq-drizzle-"));
    try {
      cpSync(migrationsFolder, out, { recursive: true });
      const before = readdirSync(out).sort();
      const cwd = join(import.meta.dirname, "..");
      // drizzle-kit prepends "./" to --out, so the path must be relative.
      const result = spawnSync(
        "pnpm",
        [
          "exec",
          "drizzle-kit",
          "generate",
          "--dialect=sqlite",
          "--schema=src/schema.ts",
          `--out=${relative(cwd, out)}`,
        ],
        { cwd, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("No schema changes");
      expect(readdirSync(out).sort()).toEqual(before);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 30_000);
});
