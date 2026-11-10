// LunasQ process (ADR uw-28-instalador): the database, the real adapters, the HTTP server on
// localhost and the in-process modules (outbox, orchestrator, PR polling). `lunasq start`
// starts it; the tests pass fakes in `adapters`.
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import {
  type GitAdapter,
  type GitHubAdapter,
  type HerdrAdapter,
  type ProcessRunner,
  RealGit,
  RealGitHub,
  RealHerdr,
  ShellProcessRunner,
} from "@lunasq/adapters";
import {
  type LunasqDatabase,
  migrateDatabase,
  openDatabase,
  ProjectRepository,
  TaskWorktreeRepository,
} from "@lunasq/db";
import type { SchedulerConfigInput } from "@lunasq/schemas";
import { createApp } from "../app.ts";
import { DeliveryService } from "../delivery/service.ts";
import { subscribeDelivery } from "../delivery/subscribe.ts";
import { Orchestrator } from "../dispatcher/orchestrator.ts";
import { EvidenceService } from "../evidence/service.ts";
import { AgentReviewerTranscriptSource, ClaudeTranscriptSource } from "../evidence/sources.ts";
import { PrPoller } from "../github/poller.ts";
import { subscribeAfterMergeHooks } from "../hooks/after-merge.ts";
import { subscribeOnFailureHooks } from "../hooks/on-failure.ts";
import { HookService } from "../hooks/service.ts";
import { CodexCliReviewerExecutor } from "../mcp/codex-reviewer.ts";
import { CopilotCliReviewerExecutor } from "../mcp/copilot-reviewer.ts";
import { OutboxPublisher } from "../outbox/publisher.ts";
import { SUBAGENT_HOOK_PATH } from "../subagents/routes.ts";
import { PaneTestGate } from "../test-gate/gate.ts";

/** Localhost only: the LunasQ MCP and the hooks authenticate with the run token, the API does not. */
export const DEFAULT_HOSTNAME = "127.0.0.1";

export interface RuntimeOptions {
  dbPath: string;
  /** 0 picks a free port. */
  port: number;
  hostname?: string;
  /** Stable MCP file (ADR 0002) and settings with the subagent hooks (ADR uw-19-revisores). */
  mcpConfigPath: string;
  hookSettingsPath: string;
  copilotAgentsPath?: string;
  /**
   * Usage collector feature flag (ADR uw-20-usage-collector): Claude Code telemetry toward
   * the local OTLP endpoints; on by default. `false` removes the OTEL variables from the panes
   * and does not mount the endpoints.
   */
  telemetry?: boolean;
  /** Front end build (`packages/web/dist/app`); without it the server only exposes the API. */
  webRoot?: string;
  /** How often GitHub is queried for open PRs (60 s by default). */
  prPollIntervalMs?: number;
  /** Scheduler limits and cadence; without this, the defaults of ADR 0014. */
  scheduler?: SchedulerConfigInput;
  adapters?: {
    herdr?: HerdrAdapter;
    github?: GitHubAdapter;
    git?: GitAdapter;
    processes?: ProcessRunner;
  };
  log?: (message: string) => void;
}

export interface Runtime {
  /** `http://<host>:<port>`, without a trailing `/`. */
  url: string;
  /** Extra variables the dispatcher puts on each agent pane. */
  paneEnv: Record<string, string>;
  stop(): Promise<void>;
}

/**
 * Variables with which Claude Code exports metrics and events to the own collector
 * (docs/tech-stack.md, Variables the dispatcher passes to each pane). The per-Run attributes and the
 * authentication header (`telemetryRunEnv`) are added by the dispatcher.
 */
export function telemetryEnv(baseUrl: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: baseUrl,
    OTEL_LOG_TOOL_DETAILS: "1",
  };
}

/** URLs of the LunasQ MCP and the hooks endpoint that go in Claude Code's stable files. */
export function runtimeUrls(baseUrl: string): { mcp: string; hooks: string } {
  return { mcp: `${baseUrl}/mcp`, hooks: `${baseUrl}${SUBAGENT_HOOK_PATH}` };
}

/** Opens the database (creates it if missing) and applies the pending migrations; idempotent. */
export function prepareDatabase(path: string): LunasqDatabase {
  const db = openDatabase(path);
  try {
    migrateDatabase(db);
  } catch (err) {
    db.$client.close();
    throw err;
  }
  return db;
}

function listen(
  port: number,
  hostname: string,
  fetch: (req: Request, env: unknown) => Response | Promise<Response>,
) {
  return new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
    const server = serve({ fetch, port, hostname }, (info: AddressInfo) =>
      resolve({ server, port: info.port }),
    );
    server.once("error", reject);
  });
}

function close(server: ServerType) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    // An open SSE client must not keep the process from ending.
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}

/** Builds the in-process modules over the database and the URL already known; it starts nothing. */
function compose(opts: RuntimeOptions, db: LunasqDatabase, url: string, log: (m: string) => void) {
  const herdr = opts.adapters?.herdr ?? new RealHerdr();
  const github = opts.adapters?.github ?? new RealGitHub();
  const git = opts.adapters?.git ?? new RealGit();
  const processes = opts.adapters?.processes ?? new ShellProcessRunner();
  const copilotEvidencePath = join(dirname(opts.dbPath), "copilot-reviewers");
  const codexEvidencePath = join(dirname(opts.dbPath), "codex-reviewers");
  const copilotReviewers = new CopilotCliReviewerExecutor({
    processes,
    agentsPath:
      opts.copilotAgentsPath ??
      join(process.env.COPILOT_HOME ?? join(homedir(), ".copilot"), "agents", "lunasq"),
    evidencePath: copilotEvidencePath,
  });
  const codexReviewers = new CodexCliReviewerExecutor({
    processes,
    evidencePath: codexEvidencePath,
  });
  const urls = runtimeUrls(url);
  const paneEnv = opts.telemetry === false ? {} : telemetryEnv(url);

  const publisher = new OutboxPublisher({
    db,
    onError: (error) => log(`outbox: ${error.message}`),
  });
  const evidence = new EvidenceService({
    db,
    git,
    transcripts: new AgentReviewerTranscriptSource({
      claude: new ClaudeTranscriptSource(),
      evidencePaths: { copilot: copilotEvidencePath, codex: codexEvidencePath },
    }),
  });
  const orchestrator = new Orchestrator({
    db,
    herdr,
    processes,
    evidence,
    mcp: { configPath: opts.mcpConfigPath, url: urls.mcp },
    hooks: { settingsPath: opts.hookSettingsPath, url: urls.hooks },
    publisher,
    paneEnv,
    // HookService needs the orchestrator's worktrees, so it is built right after: the dispatcher only
    // calls it from a launch, never while composing.
    phaseHooks: { run: (input) => hooks.run(input) },
    ...(opts.scheduler && { config: opts.scheduler }),
    onDispatchError: (error, runId) => log(`dispatcher: run ${runId}: ${error.message}`),
    onSchedulerError: (error) => log(`scheduler: ${error.message}`),
    onReconcileError: (error, subject) =>
      log(`reconciliation: ${subject ?? "-"}: ${error.message}`),
  });
  const hooks = new HookService({
    db,
    git,
    herdr,
    projects: new ProjectRepository(db),
    tasks: new TaskWorktreeRepository(db),
    worktrees: orchestrator.worktrees,
  });
  const testGate = new PaneTestGate({ db, git, herdr, worktrees: orchestrator.worktrees });
  const app = createApp({
    db,
    copilotReviewers,
    codexReviewers,
    telemetry: opts.telemetry !== false,
    ...(opts.scheduler && { scheduler: opts.scheduler }),
    ...(opts.webRoot && { webRoot: opts.webRoot }),
    testGate,
    phaseHooks: hooks,
    hooks,
    // Inbox (ADR uw-27-bandeja): answering questions, listing blocks and focusing their pane.
    questions: orchestrator.questions,
    blocked: () => orchestrator.watcher.blocked(),
    focus: (name) => herdr.focusAgent(name),
  });
  if (orchestrator.notifications) {
    app.route("/api/notifications", orchestrator.notifications.routes);
  }
  const poller = new PrPoller({
    github,
    db,
    publisher,
    ...(opts.prPollIntervalMs !== undefined && { intervalMs: opts.prPollIntervalMs }),
    onError: (error) => log(`github: ${error.message}`),
  });
  const unsubscribeAfterMerge = subscribeAfterMergeHooks({
    publisher,
    hooks,
    onError: (error, taskId) => log(`after_merge: ${taskId}: ${error.message}`),
  });
  const unsubscribeOnFailure = subscribeOnFailureHooks({
    publisher,
    hooks,
    onError: (error, taskId) => log(`on_failure: ${taskId}: ${error.message}`),
  });

  // Delivery runs inside the verifier's Run when it records a pass (ADR uw-26-entrega).
  const delivery = new DeliveryService({
    db,
    git,
    github,
    hooks,
    testGate,
    worktrees: orchestrator.worktrees,
    runs: orchestrator.dispatcher,
    evidence,
  });
  const unsubscribeDelivery = subscribeDelivery({
    publisher,
    delivery,
    onError: (error, taskId) => log(`entrega: ${taskId}: ${error.message}`),
  });

  return {
    app,
    paneEnv,
    publisher,
    orchestrator,
    poller,
    delivery,
    unsubscribeAfterMerge,
    unsubscribeOnFailure,
    unsubscribeDelivery,
  };
}

export async function startRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const hostname = opts.hostname ?? DEFAULT_HOSTNAME;
  const db = prepareDatabase(opts.dbPath);

  // Listening happens before composing: the URL (with the real port) goes in Claude Code's files.
  let handler: ((req: Request, env: unknown) => Response | Promise<Response>) | undefined;
  let listening: Awaited<ReturnType<typeof listen>>;
  try {
    listening = await listen(opts.port, hostname, (req, env) =>
      handler ? handler(req, env) : new Response("arrancando", { status: 503 }),
    );
  } catch (err) {
    db.$client.close();
    throw err;
  }
  const { server } = listening;
  const url = `http://${hostname}:${listening.port}`;

  let parts: ReturnType<typeof compose>;
  try {
    parts = compose(opts, db, url, log);
  } catch (err) {
    // Without this the server, already listening, would keep the process alive.
    await close(server);
    db.$client.close();
    throw err;
  }
  const {
    app,
    paneEnv,
    publisher,
    orchestrator,
    poller,
    delivery,
    unsubscribeAfterMerge,
    unsubscribeOnFailure,
    unsubscribeDelivery,
  } = parts;
  // env carries the connection (incoming): without forwarding it, the loopback guard does not see the peer.
  handler = (req, env) => app.fetch(req, env);

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      unsubscribeAfterMerge();
      unsubscribeOnFailure();
      unsubscribeDelivery();
      await poller.stop();
      await orchestrator.stop();
      await publisher.stop();
      await close(server);
      db.$client.close();
    })();
    return stopping;
  };

  try {
    await orchestrator.start();
    await publisher.start();
    await poller.start();
    // A delivery a restart left half done is resumed without holding back the start.
    void delivery
      .recover()
      .catch((error: unknown) =>
        log(`entrega: ${error instanceof Error ? error.message : String(error)}`),
      );
  } catch (err) {
    await stop();
    throw err;
  }
  return { url, paneEnv, stop };
}
