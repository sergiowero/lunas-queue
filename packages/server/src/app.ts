// Composición de la API HTTP, del LunasQ MCP, del endpoint de hooks de subagentes y de los
// estáticos del front end. El servidor (listen, SSE) se monta en unidades posteriores.
import { type GitAdapter, RealGit, ShellProcessRunner } from "@lunasq/adapters";
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
import { changeStreamRoutes, DEFAULT_CHANGE_STREAM_INTERVAL_MS } from "./api/stream.ts";
import { taskRoutes } from "./api/tasks.ts";
import { queueRoutes, taskViewRoutes } from "./api/views.ts";
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
  /**
   * Hooks after_implementation, before_verification y after_verification: quien compone el
   * servidor pasa el HookService. Sin él, los puntos pasan sin correr nada.
   */
  phaseHooks?: PhaseHooks;
  /** Configuración del scheduler: la cola muestra el mismo score con el que despacha. */
  scheduler?: SchedulerConfigInput;
  /** Lectura de la evidencia en el repo cuando el worktree ya no existe; por defecto git real. */
  git?: GitAdapter;
  /** Build del front end (`packages/web/dist`); sin él no se sirven estáticos. */
  webRoot?: string;
  now?: () => Date;
  /** Cada cuánto el stream SSE de cambios mira el Event log. */
  changeStreamIntervalMs?: number;
}

export function createApp({
  db,
  testGate,
  commitVerifier,
  phaseHooks,
  scheduler,
  webRoot,
  git = new RealGit(),
  now = () => new Date(),
  changeStreamIntervalMs = DEFAULT_CHANGE_STREAM_INTERVAL_MS,
}: AppDeps): Hono {
  const runner = new ShellProcessRunner();
  const mcp = new LunasqMcpService({
    db,
    testGate: testGate ?? new UnavailableTestGate(),
    commitVerifier: commitVerifier ?? new GitCommitVerifier(runner),
    phaseHooks: phaseHooks ?? new NoPhaseHooks(),
  });
  const tasks = new TaskRepository(db);
  const projects = new ProjectRepository(db);
  const taskViews = new TaskViewRepository(db);
  const views = {
    db,
    tasks,
    projects,
    git,
    views: taskViews,
    state: new SchedulerStateRepository(db),
    config: SchedulerConfig.parse(scheduler ?? {}),
    now,
  };
  const app = new Hono()
    .route("/mcp", mcpRoutes(mcp))
    .route(SUBAGENT_HOOK_PATH, subagentHookRoutes(db))
    .route("/api/projects", projectRoutes(projects))
    .route("/api/tasks/:id/specs", specRoutes(new SpecRepository(db)))
    .route("/api/queue", queueRoutes(views))
    .route("/api/stream", changeStreamRoutes(taskViews, changeStreamIntervalMs))
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
