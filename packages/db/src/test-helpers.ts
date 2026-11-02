import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach } from "vitest";
import { type LunasqDatabase, migrateDatabase, openDatabase } from "./client.ts";
import { projects, runs, tasks } from "./schema.ts";

const opened: { db: LunasqDatabase; dir: string }[] = [];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Database in a temporary file, not migrated. It is closed and deleted at the end of each test. */
export function freshDatabase(): { db: LunasqDatabase; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "lunasq-db-"));
  const file = join(dir, "lunasq.db");
  const db = openDatabase(file);
  opened.push({ db, dir });
  return { db, file };
}

/** Temporary database with the migrations applied. */
export function migratedDatabase(): LunasqDatabase {
  const { db } = freshDatabase();
  migrateDatabase(db);
  return db;
}

let seq = 0;

export function insertProject(
  db: LunasqDatabase,
  overrides: Partial<typeof projects.$inferInsert> = {},
) {
  seq += 1;
  const [row] = db
    .insert(projects)
    .values({
      name: `proyecto-${seq}`,
      repo: `sergiowero/proyecto-${seq}`,
      baseBranch: "main",
      localPath: `/tmp/proyecto-${seq}`,
      ...overrides,
    })
    .returning()
    .all();
  if (!row) throw new Error("project insert without a row");
  return row;
}

export function insertTask(
  db: LunasqDatabase,
  projectId: string,
  overrides: Partial<typeof tasks.$inferInsert> = {},
) {
  const [row] = db
    .insert(tasks)
    .values({ projectId, intent: "Hacer algo", priority: 100, ...overrides })
    .returning({ id: tasks.id })
    .all();
  if (!row) throw new Error("task insert without a row");
  // Re-reads the row: RETURNING does not see the number the tasks_assign_number trigger assigns.
  const task = db.select().from(tasks).where(eq(tasks.id, row.id)).get();
  if (!task) throw new Error("task inserted without a row");
  return task;
}

export function insertRun(
  db: LunasqDatabase,
  taskId: string,
  overrides: Partial<typeof runs.$inferInsert> = {},
) {
  seq += 1;
  const [row] = db
    .insert(runs)
    .values({
      taskId,
      phase: "implement",
      agentKind: "claude",
      runToken: `token-${seq}`,
      ...overrides,
    })
    .returning()
    .all();
  if (!row) throw new Error("run insert without a row");
  return row;
}

/** Puts the task in a state without going through the state machine: only to prepare tests. */
export function setTaskPosition(
  db: LunasqDatabase,
  taskId: string,
  position: Pick<typeof tasks.$inferInsert, "state" | "subState" | "verificationIteration">,
) {
  db.update(tasks).set(position).where(eq(tasks.id, taskId)).run();
}
