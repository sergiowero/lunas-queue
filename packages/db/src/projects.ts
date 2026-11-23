// Projects repository: validates with the @lunasq/schemas schemas what enters and what leaves
// the JSON columns, and implements the domain read port (ADR 0008).
import type { ProjectConfigReader } from "@lunasq/domain";
import {
  type Phase,
  PROJECT_UPDATED,
  Project,
  ProjectCreate,
  ProjectUpdate,
  ProjectUpdatedPayload,
} from "@lunasq/schemas";
import { asc, eq } from "drizzle-orm";
import { agentProfileExists } from "./agent-profiles.ts";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import { projects } from "./schema.ts";

export type ProjectRepositoryErrorCode =
  | "conflict"
  | "has_tasks"
  | "invalid_row"
  | "profile_not_found";

export class ProjectRepositoryError extends Error {
  readonly code: ProjectRepositoryErrorCode;
  readonly field: "name" | "localPath" | undefined;
  /** With `profile_not_found`: the phases that reference a profile that does not exist. */
  readonly phases: Phase[];

  constructor(
    code: ProjectRepositoryErrorCode,
    message: string,
    field?: "name" | "localPath",
    options?: ErrorOptions & { phases?: Phase[] },
  ) {
    super(message, options);
    this.code = code;
    this.field = field;
    this.phases = options?.phases ?? [];
    this.name = "ProjectRepositoryError";
  }
}

type Tx = Pick<LunasqDatabase, "select">;

/** Rejects phases that reference an agent profile that does not exist (nothing is written). */
function assertProfilesExist(db: Tx, selected: Partial<Record<Phase, string | null | undefined>>) {
  const missing = (Object.entries(selected) as [Phase, string | null | undefined][]).filter(
    ([, id]) => typeof id === "string" && !agentProfileExists(db, id),
  );
  if (missing.length === 0) return;
  throw new ProjectRepositoryError(
    "profile_not_found",
    `the agent profile of ${missing.map(([phase]) => phase).join(", ")} does not exist`,
    undefined,
    { phases: missing.map(([phase]) => phase) },
  );
}

type Row = typeof projects.$inferSelect;

const UNIQUE_COLUMNS = { "projects.name": "name", "projects.local_path": "localPath" } as const;

function sqliteCode(error: unknown): string | undefined {
  for (let e = error; e instanceof Error; e = e.cause) {
    if ("code" in e && typeof e.code === "string" && e.code.startsWith("SQLITE_")) return e.code;
  }
  return undefined;
}

function sqliteMessage(error: unknown): string {
  for (let e = error; e instanceof Error; e = e.cause) {
    if ("code" in e) return e.message;
  }
  return String(error);
}

/** Translates SQLite constraint violations into repository errors. */
function translate(error: unknown): never {
  const code = sqliteCode(error);
  if (code === "SQLITE_CONSTRAINT_UNIQUE") {
    const message = sqliteMessage(error);
    for (const [column, field] of Object.entries(UNIQUE_COLUMNS)) {
      if (message.includes(column)) {
        throw new ProjectRepositoryError(
          "conflict",
          `a project with that ${field} already exists`,
          field,
          {
            cause: error,
          },
        );
      }
    }
  }
  // ON DELETE RESTRICT fails with SQLITE_CONSTRAINT_TRIGGER, not with _FOREIGNKEY.
  if (code?.startsWith("SQLITE_CONSTRAINT") && /FOREIGN KEY/.test(sqliteMessage(error))) {
    throw new ProjectRepositoryError("has_tasks", "the project has tasks", undefined, {
      cause: error,
    });
  }
  throw error;
}

function toProject(row: Row): Project {
  // The herdr workspace is not configuration: the dispatcher stores it (ProjectWorkspaceRepository).
  const { herdrWorkspaceId: _herdrWorkspaceId, ...config } = row;
  const result = Project.safeParse(config);
  if (!result.success) {
    throw new ProjectRepositoryError(
      "invalid_row",
      `invalid configuration in ${row.id}`,
      undefined,
      {
        cause: result.error,
      },
    );
  }
  return result.data;
}

export class ProjectRepository implements ProjectConfigReader {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  /** Validates `input` (throws ZodError if it does not meet it) and stores the project. */
  create(input: ProjectCreate): Project {
    const values = ProjectCreate.parse(input);
    try {
      return this.db.transaction((tx) => {
        assertProfilesExist(tx, values.agentProfiles);
        const [row] = tx.insert(projects).values(values).returning().all();
        if (!row) throw new Error("project insert without a row");
        const project = toProject(row);
        this.publishUpdated(tx, project);
        return project;
      });
    } catch (error) {
      translate(error);
    }
  }

  get(projectId: string): Project | null {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    return row ? toProject(row) : null;
  }

  /** Fails with invalid_row if any row is not valid: nobody dispatches with a partial list. */
  list(): Project[] {
    return this.db.select().from(projects).orderBy(asc(projects.name)).all().map(toProject);
  }

  /**
   * Replaces the fields present in `patch` and merges `agentProfiles` per phase (null unassigns a
   * phase); null deletes testCommand and bootstrap. A profile id that does not exist is rejected with
   * `profile_not_found`. If the result is not valid, the write is rolled back. Saving publishes
   * `project.updated`, which wakes the scheduler so held tasks are reconsidered.
   */
  update(projectId: string, patch: ProjectUpdate): Project | null {
    const { agentProfiles, ...values } = ProjectUpdate.parse(patch);
    try {
      return this.db.transaction((tx) => {
        const current = tx.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!current) return null;
        if (agentProfiles) assertProfilesExist(tx, agentProfiles);
        const set = agentProfiles
          ? { ...values, agentProfiles: { ...current.agentProfiles, ...agentProfiles } }
          : values;
        if (Object.keys(set).length === 0) return toProject(current);
        const [row] = tx
          .update(projects)
          .set(set)
          .where(eq(projects.id, projectId))
          .returning()
          .all();
        if (!row) throw new Error("project update without a row");
        const project = toProject(row);
        this.publishUpdated(tx, project);
        return project;
      });
    } catch (error) {
      translate(error);
    }
  }

  private publishUpdated(tx: Pick<LunasqDatabase, "insert" | "transaction">, project: Project) {
    appendEvent(
      tx,
      {
        taskId: null,
        type: PROJECT_UPDATED,
        actor: "human",
        payload: ProjectUpdatedPayload.parse({
          projectId: project.id,
          agentProfiles: project.agentProfiles,
        }),
      },
      { publish: true },
    );
  }

  /** Returns false if it did not exist; throws has_tasks if the project has tasks. */
  delete(projectId: string): boolean {
    try {
      return this.db.delete(projects).where(eq(projects.id, projectId)).run().changes > 0;
    } catch (error) {
      translate(error);
    }
  }
}
