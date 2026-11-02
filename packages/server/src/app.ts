// Composition of the HTTP API, the LunasQ MCP, the subagent hooks endpoint and the
// front end static files. The server (listen, notifications SSE) is mounted by `startRuntime`
// (runtime/runtime.ts).
import { type GitAdapter, RealGit, ShellProcessRunner } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  ProjectRepository,
  ProjectRepositoryError,
  QuestionRepository,
  RunRepository,
  SchedulerStateRepository,
  SettingsRepository,
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
import { settingsRoutes } from "./api/settings.ts";
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
   * Test gate: whoever composes the server passes a PaneTestGate. Without it, no verification
   * passes. Tests pass fakes.
   */
  testGate?: TestGate;
  /** By default it runs git in the worktree. */
  commitVerifier?: CommitVerifier;
  /**
   * Hooks after_implementation, before_verification and after_verification: whoever composes the
   * server passes the HookService. Without it, the points pass without running anything.
   */
  phaseHooks?: PhaseHooks;
  /**
   * Base branch hooks for the hooks view: whoever composes the server passes the HookService.
   * Without it, `GET /api/projects/:id/hooks` answers 503.
   */
  hooks?: HookLister;
  /**
   * Answers the Questions: whoever composes the server passes the orchestrator's QuestionService.
   * Without it, `POST /api/questions/:id/answer` answers 503.
   */
  questions?: QuestionAnswerer;
  /**
   * Agents blocked by a permission: whoever composes the server passes `watcher.blocked`. Without it,
   * `GET /api/blocked` answers an empty list.
   */
  blocked?: BlockedSource;
  /**
   * Focuses an agent's pane in herdr (`herdr.focusAgent`). Without it, `POST /api/blocked/:runId/focus`
   * and `POST /api/runs/:runId/focus` answer 503.
   */
  focus?: AgentFocuser;
  /**
   * Usage collector (`POST /v1/logs`, `/v1/metrics`). `false` does not mount the endpoints and Claude Code
   * gets 404; it is the `telemetry` feature flag of `~/.lunasq/config.json` (ADR uw-20-usage-collector).
   */
  telemetry?: boolean;
  copilotReviewers?: CopilotReviewerExecutor;
  /** Scheduler configuration: the queue shows the same score it dispatches with. */
  scheduler?: SchedulerConfigInput;
  /** Reading the evidence in the repo when the worktree no longer exists; real git by default. */
  git?: GitAdapter;
  /** Front end build (`packages/web/dist`); without it no static files are served. */
  webRoot?: string;
  now?: () => Date;
  /** How often the SSE change stream looks at the Event log. */
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
  const runs = new RunRepository(db);
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
    .route(
      "/api/settings",
      settingsRoutes(new SettingsRepository(db), views.config.globalConcurrency),
    )
    .route("/api/tasks/:id/specs", specRoutes(new SpecRepository(db)))
    .route("/api/blocked", blockedRoutes(blocked ?? (() => []), focus))
    .route("/api/runs", runRoutes(runs, focus))
    .route("/api/questions", questionRoutes(new QuestionRepository(db), questions))
    .route("/api/queue", queueRoutes(views))
    .route("/api/stream", changeStreamRoutes(taskViews, changeStreamIntervalMs))
    .route("/api/tasks", taskViewRoutes(views))
    .route("/api/tasks", taskRoutes(tasks, runs))
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
