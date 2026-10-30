// Composición de la API HTTP, del LunasQ MCP y del endpoint de hooks de subagentes. El servidor
// (listen, SSE de notificaciones) lo monta `startRuntime` (runtime/runtime.ts).
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
  NoPhaseHooks,
  type PhaseHooks,
  type TestGate,
} from "./mcp/ports.ts";
import { mcpRoutes } from "./mcp/routes.ts";
import { LunasqMcpService } from "./mcp/service.ts";
import { SUBAGENT_HOOK_PATH, subagentHookRoutes } from "./subagents/routes.ts";
import { UnavailableTestGate } from "./test-gate/gate.ts";

export interface AppDeps {
  db: LunasqDatabase;
  /**
   * Gate de tests: quien compone el servidor pasa un PaneTestGate. Sin él, ninguna verificación
   * pasa. Los tests pasan fakes.
   */
  testGate?: TestGate;
  /** Por defecto corre git en el worktree. */
  commitVerifier?: CommitVerifier;
  /**
   * Hooks after_implementation, before_verification y after_verification: quien compone el
   * servidor pasa el HookService. Sin él, los puntos pasan sin correr nada.
   */
  phaseHooks?: PhaseHooks;
}

export function createApp({ db, testGate, commitVerifier, phaseHooks }: AppDeps): Hono {
  const runner = new ShellProcessRunner();
  const mcp = new LunasqMcpService({
    db,
    testGate: testGate ?? new UnavailableTestGate(),
    commitVerifier: commitVerifier ?? new GitCommitVerifier(runner),
    phaseHooks: phaseHooks ?? new NoPhaseHooks(),
  });
  return new Hono()
    .route("/mcp", mcpRoutes(mcp))
    .route(SUBAGENT_HOOK_PATH, subagentHookRoutes(db))
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
