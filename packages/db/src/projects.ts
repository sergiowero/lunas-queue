// Repositorio de proyectos: valida con los esquemas de @lunasq/schemas lo que entra y lo que sale
// de las columnas JSON, e implementa el puerto de lectura del dominio (ADR 0008).
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

/** Traduce las violaciones de restricciones de SQLite a errores del repositorio. */
function translate(error: unknown): never {
  const code = sqliteCode(error);
  if (code === "SQLITE_CONSTRAINT_UNIQUE") {
    const message = sqliteMessage(error);
    for (const [column, field] of Object.entries(UNIQUE_COLUMNS)) {
      if (message.includes(column)) {
        throw new ProjectRepositoryError(
          "conflict",
          `ya existe un proyecto con ese ${field}`,
          field,
          {
            cause: error,
          },
        );
      }
    }
  }
  // ON DELETE RESTRICT falla con SQLITE_CONSTRAINT_TRIGGER, no con _FOREIGNKEY.
  if (code?.startsWith("SQLITE_CONSTRAINT") && /FOREIGN KEY/.test(sqliteMessage(error))) {
    throw new ProjectRepositoryError("has_tasks", "el proyecto tiene tareas", undefined, {
      cause: error,
    });
  }
  throw error;
}

function toProject(row: Row): Project {
  const result = Project.safeParse(row);
  if (!result.success) {
    throw new ProjectRepositoryError(
      "invalid_row",
      `configuración inválida en ${row.id}`,
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

  /** Valida `input` (lanza ZodError si no cumple) y guarda el proyecto. */
  create(input: ProjectCreate): Project {
    const values = ProjectCreate.parse(input);
    try {
      const [row] = this.db.insert(projects).values(values).returning().all();
      if (!row) throw new Error("insert de project sin fila");
      return toProject(row);
    } catch (error) {
      translate(error);
    }
  }

  get(projectId: string): Project | null {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    return row ? toProject(row) : null;
  }

  /** Falla con invalid_row si alguna fila no es válida: nadie despacha con una lista parcial. */
  list(): Project[] {
    return this.db.select().from(projects).orderBy(asc(projects.name)).all().map(toProject);
  }

  /**
   * Reemplaza los campos presentes en `patch` y mezcla `agentProfiles` por fase; null borra
   * testCommand y bootstrap. Si el resultado no es válido, la escritura se revierte.
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
        if (!row) throw new Error("update de project sin fila");
        return toProject(row);
      });
    } catch (error) {
      translate(error);
    }
  }

  /** Devuelve false si no existía; lanza has_tasks si el proyecto tiene tareas. */
  delete(projectId: string): boolean {
    try {
      return this.db.delete(projects).where(eq(projects.id, projectId)).run().changes > 0;
    } catch (error) {
      translate(error);
    }
  }
}
