// Proceso de LunasQ (ADR uw-28-instalador): la base, los adapters reales, el servidor HTTP en
// localhost y los módulos en proceso (outbox, orquestador, polling de PRs). `lunasq start` lo
// arranca; los tests pasan fakes en `adapters`.
import type { AddressInfo } from "node:net";
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
import { createApp } from "../app.ts";
import { Orchestrator } from "../dispatcher/orchestrator.ts";
import { PrPoller } from "../github/poller.ts";
import { subscribeAfterMergeHooks } from "../hooks/after-merge.ts";
import { HookService } from "../hooks/service.ts";
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
  /** Telemetría de Claude Code hacia el usage collector local; activa por defecto. */
  telemetry?: boolean;
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
 * (docs/tech-stack.md, Variables que el dispatcher pasa a cada pane). Los atributos por Run
 * (`OTEL_RESOURCE_ATTRIBUTES`) los agrega el dispatcher.
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

  const herdr = opts.adapters?.herdr ?? new RealHerdr();
  const github = opts.adapters?.github ?? new RealGitHub();
  const git = opts.adapters?.git ?? new RealGit();
  const processes = opts.adapters?.processes ?? new ShellProcessRunner();
  const urls = runtimeUrls(url);
  const paneEnv = opts.telemetry === false ? {} : telemetryEnv(url);

  const publisher = new OutboxPublisher({
    db,
    onError: (error) => log(`outbox: ${error.message}`),
  });
  const orchestrator = new Orchestrator({
    db,
    herdr,
    processes,
    mcp: { configPath: opts.mcpConfigPath, url: urls.mcp },
    hooks: { settingsPath: opts.hookSettingsPath, url: urls.hooks },
    publisher,
    paneEnv,
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
  const app = createApp({
    db,
    testGate: new PaneTestGate({ db, git, herdr, worktrees: orchestrator.worktrees }),
    phaseHooks: hooks,
  });
  if (orchestrator.notifications) {
    app.route("/api/notifications", orchestrator.notifications.routes);
  }
  handler = (req) => app.fetch(req);

  const poller = new PrPoller({
    github,
    db,
    publisher,
    onError: (error) => log(`github: ${error.message}`),
  });
  const unsubscribeAfterMerge = subscribeAfterMergeHooks({
    publisher,
    hooks,
    onError: (error, taskId) => log(`after_merge: ${taskId}: ${error.message}`),
  });

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      unsubscribeAfterMerge();
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
  } catch (err) {
    await stop();
    throw err;
  }
  return { url, paneEnv, stop };
}
