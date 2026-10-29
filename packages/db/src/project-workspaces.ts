// Workspace de herdr de cada proyecto (ADR uw-16-dispatcher). No es configuración del proyecto:
// lo escribe el dispatcher al asegurar el workspace y solo sirve como pista para reencontrarlo.
import type { ProjectWorkspaceStore } from "@lunasq/domain";
import { eq } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { projects } from "./schema.ts";

export class ProjectWorkspaceRepository implements ProjectWorkspaceStore {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  get(projectId: string): string | null {
    return (
      this.db
        .select({ id: projects.herdrWorkspaceId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .get()?.id ?? null
    );
  }

  record(projectId: string, workspaceId: string): void {
    this.db
      .update(projects)
      .set({ herdrWorkspaceId: workspaceId })
      .where(eq(projects.id, projectId))
      .run();
  }
}
