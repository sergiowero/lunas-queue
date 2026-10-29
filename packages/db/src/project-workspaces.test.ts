import { describe, expect, it } from "vitest";
import { ProjectWorkspaceRepository } from "./project-workspaces.ts";
import { ProjectRepository } from "./projects.ts";
import { insertProject, migratedDatabase } from "./test-helpers.ts";

describe("ProjectWorkspaceRepository", () => {
  it("guarda el workspace de herdr del proyecto sin tocar su configuración", () => {
    const db = migratedDatabase();
    const project = insertProject(db);
    const repo = new ProjectWorkspaceRepository(db);
    expect(repo.get(project.id)).toBeNull();

    repo.record(project.id, "w3");

    expect(repo.get(project.id)).toBe("w3");
    expect(new ProjectRepository(db).get(project.id)).not.toHaveProperty("herdrWorkspaceId");
    expect(repo.get("no-existe")).toBeNull();
  });
});
