// Composición de la API HTTP y del LunasQ MCP. El servidor (listen, SSE) se monta en unidades
// posteriores.
import { ShellProcessRunner } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  ProjectRepository,
  ProjectRepositoryError,
  SpecRepository,
  SpecRepositoryError,
  TaskRepository,
  TaskRepositoryError,
} from "@lunasq/db";
import { Hono } from "hono";
import { projectRoutes } from "./api/projects.ts";
import { specRoutes } from "./api/specs.ts";
import { taskRoutes } from "./api/tasks.ts";
import {
  type CommitVerifier,
  GitCommitVerifier,
  ShellTestGate,
  type TestGate,
} from "./mcp/ports.ts";
import { mcpRoutes } from "./mcp/routes.ts";
import { LunasqMcpService } from "./mcp/service.ts";

export interface AppDeps {
  db: LunasqDatabase;
  /** Por defecto corren comandos de shell en el worktree; los tests pasan fakes. */
  testGate?: TestGate;
  commitVerifier?: CommitVerifier;
}

export function createApp({ db, testGate, commitVerifier }: AppDeps): Hono {
  const runner = new ShellProcessRunner();
  const mcp = new LunasqMcpService({
    db,
    testGate: testGate ?? new ShellTestGate(runner),
    commitVerifier: commitVerifier ?? new GitCommitVerifier(runner),
  });
  return new Hono()
    .route("/mcp", mcpRoutes(mcp))
    .route("/api/projects", projectRoutes(new ProjectRepository(db)))
    .route("/api/tasks/:id/specs", specRoutes(new SpecRepository(db)))
    .route("/api/tasks", taskRoutes(new TaskRepository(db)))
    .onError((error, c) => {
      if (
        error instanceof ProjectRepositoryError ||
        error instanceof TaskRepositoryError ||
        error instanceof SpecRepositoryError
      ) {
        return c.json({ error: error.code, message: error.message }, 500);
      }
      return c.json({ error: "internal" }, 500);
    });
}
