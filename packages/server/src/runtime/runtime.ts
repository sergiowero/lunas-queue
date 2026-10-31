// Proceso de LunasQ (ADR uw-28-instalador): la base, los adapters reales, el servidor HTTP en
// localhost y los módulos en proceso (outbox, orquestador, polling de PRs). `lunasq start` lo
// arranca; los tests pasan fakes en `adapters`.
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
import { ClaudeTranscriptSource, CopilotReviewerTranscriptSource } from "../evidence/sources.ts";
import { PrPoller } from "../github/poller.ts";
import { subscribeAfterMergeHooks } from "../hooks/after-merge.ts";
import { HookService } from "../hooks/service.ts";
import { CopilotCliReviewerExecutor } from "../mcp/copilot-reviewer.ts";
import { OutboxPublisher } from "../outbox/publisher.ts";
import { SUBAGENT_HOOK_PATH } from "../subagents/routes.ts";
import { PaneTestGate } from "../test-gate/gate.ts";

/** Solo localhost: el LunasQ MCP y los hooks se autentican con el run token, la API no. */
export const DEFAULT_HOSTNAME = "127.0.0.1";

export interface RuntimeOptions {
  dbPath: string;
  /** 0 elige un puerto libre. */
  port: number;
  hostname?: string;
  /** Archivo MCP estable (ADR 0002) y settings con los hooks de subagentes (ADR uw-19-revisores). */
  mcpConfigPath: string;
  hookSettingsPath: string;
  copilotAgentsPath?: string;
  /**
   * Feature flag del usage collector (ADR uw-20-usage-collector): telemetría de Claude Code hacia
   * los endpoints OTLP locales; activa por defecto. `false` quita las variables OTEL de los panes
   * y no monta los endpoints.
   */
  telemetry?: boolean;
  /** Build del front end (`packages/web/dist/app`); sin él el servidor solo expone la API. */
  webRoot?: string;
  /** Cada cuánto se consultan en GitHub los PR abiertos (por defecto 60 s). */
  prPollIntervalMs?: number;
  /** Límites y cadencia del scheduler; sin esto, los defaults de ADR 0014. */
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
  /** `http://<host>:<puerto>`, sin `/` final. */
  url: string;
  /** Variables extra que el dispatcher pone en cada pane de agente. */
  paneEnv: Record<string, string>;
  stop(): Promise<void>;
}

/**
 * Variables con las que Claude Code exporta métricas y eventos al collector propio
 * (docs/tech-stack.md, Variables que el dispatcher pasa a cada pane). Los atributos por Run y el
 * header de autenticación (`telemetryRunEnv`) los agrega el dispatcher.
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

/** URLs del LunasQ MCP y del endpoint de hooks que van en los archivos estables de Claude Code. */
export function runtimeUrls(baseUrl: string): { mcp: string; hooks: string } {
  return { mcp: `${baseUrl}/mcp`, hooks: `${baseUrl}${SUBAGENT_HOOK_PATH}` };
}

/** Abre la base (la crea si falta) y aplica las migraciones pendientes; idempotente. */
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
  fetch: (req: Request) => Response | Promise<Response>,
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
    // Un cliente SSE abierto no debe impedir que el proceso termine.
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}

/** Arma los módulos en proceso sobre la base y la URL ya conocidas; no arranca nada. */
function compose(opts: RuntimeOptions, db: LunasqDatabase, url: string, log: (m: string) => void) {
  const herdr = opts.adapters?.herdr ?? new RealHerdr();
  const github = opts.adapters?.github ?? new RealGitHub();
  const git = opts.adapters?.git ?? new RealGit();
  const processes = opts.adapters?.processes ?? new ShellProcessRunner();
  const copilotEvidencePath = join(dirname(opts.dbPath), "copilot-reviewers");
  const copilotReviewers = new CopilotCliReviewerExecutor({
    processes,
    agentsPath:
      opts.copilotAgentsPath ??
      join(process.env.COPILOT_HOME ?? join(homedir(), ".copilot"), "agents", "lunasq"),
    evidencePath: copilotEvidencePath,
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
    transcripts: new CopilotReviewerTranscriptSource({
      claude: new ClaudeTranscriptSource(),
      evidencePath: copilotEvidencePath,
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
    ...(opts.scheduler && { config: opts.scheduler }),
    onDispatchError: (error, runId) => log(`dispatcher: run ${runId}: ${error.message}`),
    onSchedulerError: (error) => log(`scheduler: ${error.message}`),
    onReconcileError: (error, subject) =>
      log(`reconciliación: ${subject ?? "-"}: ${error.message}`),
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
    telemetry: opts.telemetry !== false,
    ...(opts.scheduler && { scheduler: opts.scheduler }),
    ...(opts.webRoot && { webRoot: opts.webRoot }),
    testGate,
    phaseHooks: hooks,
    hooks,
    // Bandeja (ADR uw-27-bandeja): responder preguntas, listar bloqueos y enfocar su pane.
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

  // La entrega corre dentro del Run del verificador cuando éste registra un pass (ADR uw-26-entrega).
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
    unsubscribeDelivery,
  };
}

export async function startRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const hostname = opts.hostname ?? DEFAULT_HOSTNAME;
  const db = prepareDatabase(opts.dbPath);

  // Se escucha antes de componer: la URL (con el puerto real) va en los archivos de Claude Code.
  let handler: ((req: Request) => Response | Promise<Response>) | undefined;
  let listening: Awaited<ReturnType<typeof listen>>;
  try {
    listening = await listen(opts.port, hostname, (req) =>
      handler ? handler(req) : new Response("arrancando", { status: 503 }),
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
    // Sin esto el servidor, ya escuchando, mantendría vivo el proceso.
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
    unsubscribeDelivery,
  } = parts;
  handler = (req) => app.fetch(req);

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      unsubscribeAfterMerge();
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
    // Una entrega que un reinicio dejó a medias se retoma sin frenar el arranque.
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
