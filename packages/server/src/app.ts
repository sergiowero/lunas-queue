// Composición de la API HTTP, del LunasQ MCP y del endpoint de hooks de subagentes. El servidor
// (listen, SSE) se monta en unidades posteriores.
import { ShellProcessRunner } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  ProjectRepository,
  ProjectRepositoryError,
  QuestionRepository,
  SpecRepository,
  SpecRepositoryError,
  TaskRepository,
  TaskRepositoryError,
} from "@lunasq/db";
import { Hono } from "hono";
import { projectRoutes } from "./api/projects.ts";
import {
  type BlockedSource,
  blockedRoutes,
  type QuestionAnswerer,
  questionRoutes,
} from "./api/questions.ts";
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
  /**
   * Responde las Questions: quien compone el servidor pasa el QuestionService del orquestador.
   * Sin él, `POST /api/questions/:id/answer` responde 503.
   */
  questions?: QuestionAnswerer;
  /**
   * Agentes bloqueados por un permiso: quien compone el servidor pasa `watcher.blocked`. Sin él,
   * `GET /api/blocked` responde una lista vacía.
   */
  blocked?: BlockedSource;
}

export function createApp({
  db,
  testGate,
  commitVerifier,
  phaseHooks,
  questions,
  blocked,
}: AppDeps): Hono {
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
    .route("/api/blocked", blockedRoutes(blocked ?? (() => [])))
    .route("/api/questions", questionRoutes(new QuestionRepository(db), questions))
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
