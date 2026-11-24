import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach } from "vitest";
import { type LunasqDatabase, migrateDatabase, openDatabase } from "./client.ts";
import { agentProfiles, projects, runs, tasks } from "./schema.ts";

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

/** Models of an agent profile: provider, optional model, optional effort and args. */
export type TestProfileModel = {
  kind: "claude" | "copilot" | "codex" | "opencode";
  model?: string;
  effort?: string;
  args?: string[];
};

/** Inserts an agent profile (one Claude model by default) and returns its row. */
export function insertAgentProfile(
  db: LunasqDatabase,
  overrides: { name?: string; models?: TestProfileModel[] } = {},
) {
  seq += 1;
  const [row] = db
    .insert(agentProfiles)
    .values({
      name: overrides.name ?? `perfil-${seq}`,
      models: (overrides.models ?? [{ kind: "claude" }]).map((m) => ({ args: [], ...m })),
    })
    .returning()
    .all();
  if (!row) throw new Error("agent profile insert without a row");
  return row;
}

const PHASES = ["refine", "implement", "verify", "deliver"] as const;

/** Phase profiles that all point at `profileId` (what a configured project looks like). */
export function allPhasesWith(profileId: string | null) {
  return Object.fromEntries(PHASES.map((phase) => [phase, profileId]));
}

/** Every phase on the shared "default" profile; `{}` on databases migrated before profiles existed. */
function defaultPhaseProfiles(db: LunasqDatabase): Record<string, unknown> {
  const hasTable = db.$client
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'agent_profiles'")
    .get();
  if (!hasTable) return {};
  const profile =
    db.select().from(agentProfiles).where(eq(agentProfiles.name, "default")).get() ??
    insertAgentProfile(db, { name: "default" });
  return allPhasesWith(profile.id);
}

/**
 * Inserts a project. Unless the test passes its own `agentProfiles`, every phase is assigned to a
 * default Claude profile (created once per database) so the project can be dispatched.
 */
export function insertProject(
  db: LunasqDatabase,
  overrides: Partial<typeof projects.$inferInsert> = {},
) {
  seq += 1;
  const assigned = overrides.agentProfiles ?? defaultPhaseProfiles(db);
  const [row] = db
    .insert(projects)
    .values({
      name: `proyecto-${seq}`,
      repo: `sergiowero/proyecto-${seq}`,
      baseBranch: "main",
      localPath: `/tmp/proyecto-${seq}`,
      ...overrides,
      agentProfiles: assigned,
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
    .values({ projectId, goal: "Hacer algo", priority: 100, ...overrides })
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
  position: Pick<
    typeof tasks.$inferInsert,
    "state" | "subState" | "verificationIteration" | "verificationCycleStart"
  >,
) {
  db.update(tasks).set(position).where(eq(tasks.id, taskId)).run();
}
