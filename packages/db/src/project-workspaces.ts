// herdr workspace of each project (ADR uw-16-dispatcher). It is not project configuration:
// the dispatcher writes it when ensuring the workspace and it only serves as a hint to find it again.
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
