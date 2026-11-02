import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { migrateDatabase, migrationsFolder, openDatabase } from "./client.ts";
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
  it("abre en WAL con llaves foráneas activas y busy_timeout", () => {
    const { db } = freshDatabase();
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.$client.pragma("busy_timeout", { simple: true })).toBeGreaterThan(0);
  });
});

describe("migraciones", () => {
  it("aplican en limpio sobre una base vacía y crean todas las tablas", () => {
    const { db } = freshDatabase();
    expect(userTables(db)).toEqual([]);
    migrateDatabase(db);
    expect(userTables(db)).toEqual(TABLES);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    expect(db.$client.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("son idempotentes: aplicar dos veces no cambia nada", () => {
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

  it("la migración de settings conserva las filas del outbox y de events de una base ya en uso", () => {
    const { db } = freshDatabase();
    // Base en el estado anterior a la migración 0011: el journal se recorta a las once primeras.
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

  it("están sincronizadas con el esquema de Drizzle", () => {
    const out = mkdtempSync(join(tmpdir(), "lunasq-drizzle-"));
    try {
      cpSync(migrationsFolder, out, { recursive: true });
      const before = readdirSync(out).sort();
      const cwd = join(import.meta.dirname, "..");
      // drizzle-kit antepone "./" a --out, así que la ruta debe ser relativa.
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
