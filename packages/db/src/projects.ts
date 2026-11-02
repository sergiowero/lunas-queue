// Projects repository: validates with the @lunasq/schemas schemas what enters and what leaves
// the JSON columns, and implements the domain read port (ADR 0008).
import type { ProjectConfigReader } from "@lunasq/domain";
import { Project, ProjectCreate, ProjectUpdate } from "@lunasq/schemas";
import { asc, eq } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { projects } from "./schema.ts";

export type ProjectRepositoryErrorCode = "conflict" | "has_tasks" | "invalid_row";

export class ProjectRepositoryError extends Error {
  readonly code: ProjectRepositoryErrorCode;
  readonly field: "name" | "localPath" | undefined;

  constructor(
    code: ProjectRepositoryErrorCode,
    message: string,
    field?: "name" | "localPath",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.field = field;
    this.name = "ProjectRepositoryError";
  }
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
      const [row] = this.db.insert(projects).values(values).returning().all();
      if (!row) throw new Error("project insert without a row");
      return toProject(row);
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
   * Replaces the fields present in `patch` and merges `agentProfiles` per phase; null deletes
   * testCommand and bootstrap. If the result is not valid, the write is rolled back.
   */
  update(projectId: string, patch: ProjectUpdate): Project | null {
    const { agentProfiles, ...values } = ProjectUpdate.parse(patch);
    try {
      return this.db.transaction((tx) => {
        const current = tx.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!current) return null;
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
        return toProject(row);
      });
    } catch (error) {
      translate(error);
    }
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
