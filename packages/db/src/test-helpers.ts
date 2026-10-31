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

/** Base de datos en un archivo temporal, sin migrar. Se cierra y borra al terminar cada test. */
export function freshDatabase(): { db: LunasqDatabase; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "lunasq-db-"));
  const file = join(dir, "lunasq.db");
  const db = openDatabase(file);
  opened.push({ db, dir });
  return { db, file };
}

/** Base de datos temporal con las migraciones aplicadas. */
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
  if (!row) throw new Error("insert de project sin fila");
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
  if (!row) throw new Error("insert de task sin fila");
  // Relee la fila: RETURNING no ve el número que asigna el trigger tasks_assign_number.
  const task = db.select().from(tasks).where(eq(tasks.id, row.id)).get();
  if (!task) throw new Error("task insertada sin fila");
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
  if (!row) throw new Error("insert de run sin fila");
  return row;
}

/** Coloca la tarea en un estado sin recorrer la máquina de estados: solo para preparar tests. */
export function setTaskPosition(
  db: LunasqDatabase,
  taskId: string,
  position: Pick<typeof tasks.$inferInsert, "state" | "subState" | "verificationIteration">,
) {
  db.update(tasks).set(position).where(eq(tasks.id, taskId)).run();
}
