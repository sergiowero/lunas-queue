// Composición de la API HTTP, del LunasQ MCP, del endpoint de hooks de subagentes y de los
// estáticos del front end. El servidor (listen, SSE) se monta en unidades posteriores.
import { ShellProcessRunner } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  ProjectRepository,
  ProjectRepositoryError,
  SchedulerStateRepository,
  SpecRepository,
  SpecRepositoryError,
  TaskRepository,
  TaskRepositoryError,
  TaskViewRepository,
} from "@lunasq/db";
import { SchedulerConfig, type SchedulerConfigInput } from "@lunasq/schemas";
import { Hono } from "hono";
import { projectRoutes } from "./api/projects.ts";
import { specRoutes } from "./api/specs.ts";
import { taskRoutes } from "./api/tasks.ts";
import { queueRoutes, taskViewRoutes } from "./api/views.ts";
import { type CommitVerifier, GitCommitVerifier, type TestGate } from "./mcp/ports.ts";
import { mcpRoutes } from "./mcp/routes.ts";
import { LunasqMcpService } from "./mcp/service.ts";
import { SUBAGENT_HOOK_PATH, subagentHookRoutes } from "./subagents/routes.ts";
import { UnavailableTestGate } from "./test-gate/gate.ts";
import { webRoutes } from "./web/static.ts";

export interface AppDeps {
  db: LunasqDatabase;
  /**
   * Gate de tests: quien compone el servidor pasa un PaneTestGate. Sin él, ninguna verificación
   * pasa. Los tests pasan fakes.
   */
  testGate?: TestGate;
  /** Por defecto corre git en el worktree. */
  commitVerifier?: CommitVerifier;
  /** Configuración del scheduler: la cola muestra el mismo score con el que despacha. */
  scheduler?: SchedulerConfigInput;
  /** Build del front end (`packages/web/dist`); sin él no se sirven estáticos. */
  webRoot?: string;
  now?: () => Date;
}

export function createApp({
  db,
  testGate,
  commitVerifier,
  scheduler,
  webRoot,
  now = () => new Date(),
}: AppDeps): Hono {
  const runner = new ShellProcessRunner();
  const mcp = new LunasqMcpService({
    db,
    testGate: testGate ?? new UnavailableTestGate(),
    commitVerifier: commitVerifier ?? new GitCommitVerifier(runner),
  });
  const tasks = new TaskRepository(db);
  const views = {
    tasks,
    views: new TaskViewRepository(db),
    state: new SchedulerStateRepository(db),
    config: SchedulerConfig.parse(scheduler ?? {}),
    now,
  };
  const app = new Hono()
    .route("/mcp", mcpRoutes(mcp))
    .route(SUBAGENT_HOOK_PATH, subagentHookRoutes(db))
    .route("/api/projects", projectRoutes(new ProjectRepository(db)))
    .route("/api/tasks/:id/specs", specRoutes(new SpecRepository(db)))
    .route("/api/queue", queueRoutes(views))
    .route("/api/tasks", taskViewRoutes(views))
    .route("/api/tasks", taskRoutes(tasks))
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
  return webRoot ? app.route("/", webRoutes(webRoot)) : app;
}
