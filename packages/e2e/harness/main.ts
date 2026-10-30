// Servidor del piloto e2e: el runtime real de LunasQ (base SQLite, API, MCP, scheduler, dispatcher,
// entrega, hooks y front end) con herdr y GitHub falsos y un agente guionado, sobre un repo git
// real en un directorio temporal. Playwright lo arranca con `webServer`; `/control` lo maneja.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGitHub } from "@lunasq/adapters";
import { startRuntime } from "@lunasq/server";
import { runTurn } from "./agent.ts";
import { createFixture, mergeIntoMain } from "./fixture.ts";
import { ScriptedHerdr } from "./scripted-herdr.ts";

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 7461);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 7462);
const WEB_ROOT = fileURLToPath(new URL("../../web/dist/app", import.meta.url));
const SHUTDOWN_TIMEOUT_MS = 10_000;

// Los commits que hace LunasQ (evidencia, trailers, rebase) necesitan identidad de autor y de
// committer: en CI no hay config de git y, a diferencia de macOS, git no la deduce del hostname.
// Sin config global tampoco influyen la firma ni los hooks del git del desarrollador.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
for (const role of ["AUTHOR", "COMMITTER"]) {
  process.env[`GIT_${role}_NAME`] = "LunasQ e2e";
  process.env[`GIT_${role}_EMAIL`] = "e2e@lunasq.test";
}

const root = mkdtempSync(join(tmpdir(), "lunasq-e2e-"));
const fixture = createFixture(root);
const github = new FakeGitHub({ repo: "acme/piloto" });
const errors: string[] = [];
const log = (message: string) => {
  errors.push(message);
  console.error(message);
};

let baseUrl = "";
const herdr = new ScriptedHerdr({
  repo: fixture.repo,
  worktrees: fixture.worktrees,
  onPrompt: (agent) => runTurn(agent, { baseUrl }),
  onError: (error, agent) => log(`agente ${agent}: ${error.message}`),
});

const runtime = await startRuntime({
  dbPath: join(root, "lunasq.db"),
  port: APP_PORT,
  mcpConfigPath: join(root, "mcp.json"),
  hookSettingsPath: join(root, "claude-settings.json"),
  webRoot: WEB_ROOT,
  prPollIntervalMs: 1_000,
  scheduler: { tickIntervalMs: 1_000 },
  adapters: { herdr, github },
  log,
});
baseUrl = runtime.url;

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json" },
  });
  if (!res.ok)
    throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

const project = await api<{ id: string }>("/api/projects", {
  method: "POST",
  body: JSON.stringify({
    name: "Piloto",
    repo: "acme/piloto",
    baseBranch: "main",
    localPath: fixture.repo,
    testCommand: "sh test.sh",
  }),
});

/** Mergea el PR de la tarea: en GitHub (falso) y en el `main` del origin (git real). */
async function mergeTask(taskId: string): Promise<{ url: string }> {
  const task = await api<{ branch: string | null }>(`/api/tasks/${taskId}`);
  if (!task.branch) throw new Error(`la tarea ${taskId} no tiene branch`);
  const pr = await github.findOpenPr({ head: task.branch, base: "main" });
  if (!pr) throw new Error(`la tarea ${taskId} no tiene un PR abierto`);
  mergeIntoMain(fixture, task.branch);
  github.merge(pr.url);
  return { url: pr.url };
}

const control = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://control");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === "/health") return send(200, { ok: true });
    if (url.pathname === "/state") {
      return send(200, { baseUrl, projectId: project.id, repo: fixture.repo, errors });
    }
    const merge = /^\/merge\/([^/]+)$/.exec(url.pathname);
    if (merge?.[1] && req.method === "POST") return send(200, await mergeTask(merge[1]));
    send(404, { error: "not_found" });
  } catch (error) {
    send(500, { error: error instanceof Error ? error.message : String(error) });
  }
});
control.listen(CONTROL_PORT, "127.0.0.1");

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  control.close();
  // Un guion colgado no debe impedir el cierre ni dejar el directorio temporal.
  await Promise.race([
    herdr.idle(),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  await runtime.stop();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
