import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateDatabase, migrationsFolder, openDatabase } from "./client.ts";
import { freshDatabase } from "./test-helpers.ts";

const TABLES = [
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
