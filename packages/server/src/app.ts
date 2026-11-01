// Composición de la API HTTP, del LunasQ MCP, del endpoint de hooks de subagentes y de los
// estáticos del front end. El servidor (listen, SSE de notificaciones) lo monta `startRuntime`
// (runtime/runtime.ts).
import { type GitAdapter, RealGit, ShellProcessRunner } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  ProjectRepository,
  ProjectRepositoryError,
  QuestionRepository,
  RunRepository,
  SchedulerStateRepository,
  SpecRepository,
  SpecRepositoryError,
  TaskRepository,
  TaskRepositoryError,
  TaskViewRepository,
} from "@lunasq/db";
import { SchedulerConfig, type SchedulerConfigInput } from "@lunasq/schemas";
import { Hono } from "hono";
import { type HookLister, hookRoutes } from "./api/hooks.ts";
import { projectRoutes } from "./api/projects.ts";
import {
  type AgentFocuser,
  type BlockedSource,
  blockedRoutes,
  type QuestionAnswerer,
  questionRoutes,
} from "./api/questions.ts";
import { runRoutes } from "./api/runs.ts";
import { specRoutes } from "./api/specs.ts";
import { changeStreamRoutes, DEFAULT_CHANGE_STREAM_INTERVAL_MS } from "./api/stream.ts";
import { taskRoutes } from "./api/tasks.ts";
import { queueRoutes, taskViewRoutes } from "./api/views.ts";
import type { CopilotReviewerExecutor } from "./mcp/copilot-reviewer.ts";
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
import { usageRoutes } from "./usage/routes.ts";
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
  /**
   * Hooks de la rama base para la vista de hooks: quien compone el servidor pasa el HookService.
   * Sin él, `GET /api/projects/:id/hooks` responde 503.
   */
  hooks?: HookLister;
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
  /**
   * Enfoca en herdr el pane de un agente (`herdr.focusAgent`). Sin él, `POST /api/blocked/:runId/focus`
   * y `POST /api/runs/:runId/focus` responden 503.
   */
  focus?: AgentFocuser;
  /**
   * Usage collector (`POST /v1/logs`, `/v1/metrics`). `false` no monta los endpoints y Claude Code
   * recibe 404; es el feature flag `telemetry` de `~/.lunasq/config.json` (ADR uw-20-usage-collector).
   */
  telemetry?: boolean;
  copilotReviewers?: CopilotReviewerExecutor;
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
  copilotReviewers,
  hooks,
  questions,
  blocked,
  focus,
  scheduler,
  telemetry = true,
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
    ...(copilotReviewers && { copilotReviewers }),
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
    .route("/api/projects/:id/hooks", hookRoutes({ projects, views: taskViews, hooks }))
    .route("/api/projects", projectRoutes(projects))
    .route("/api/tasks/:id/specs", specRoutes(new SpecRepository(db)))
    .route("/api/blocked", blockedRoutes(blocked ?? (() => []), focus))
    .route("/api/runs", runRoutes(new RunRepository(db), focus))
    .route("/api/questions", questionRoutes(new QuestionRepository(db), questions))
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
  if (telemetry) app.route("/", usageRoutes(db));
  return webRoot ? app.route("/", webRoutes(webRoot)) : app;
}
