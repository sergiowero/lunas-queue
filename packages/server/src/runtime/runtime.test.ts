import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGit, FakeGitHub, FakeHerdr, FakeProcessRunner } from "@lunasq/adapters";
import { createQuestion, openDatabase, RunRepository } from "@lunasq/db";
import { insertProject, insertRun, insertTask } from "@lunasq/db/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_HOOK_PATH } from "../subagents/routes.ts";
import { prepareDatabase, type RuntimeOptions, startRuntime, telemetryEnv } from "./runtime.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function options(overrides: Partial<RuntimeOptions> = {}): RuntimeOptions & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lunasq-runtime-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    dbPath: join(dir, "lunasq.db"),
    port: 0,
    mcpConfigPath: join(dir, "mcp.json"),
    hookSettingsPath: join(dir, "claude-settings.json"),
    adapters: {
      herdr: new FakeHerdr(),
      github: new FakeGitHub(),
      git: new FakeGit(),
      processes: new FakeProcessRunner(),
    },
    ...overrides,
  };
}

async function start(opts: RuntimeOptions) {
  const runtime = await startRuntime(opts);
  cleanups.push(() => runtime.stop());
  return runtime;
}

describe("telemetryEnv", () => {
  it("activa la telemetría de Claude Code hacia el collector local por OTLP http/json", () => {
    expect(telemetryEnv("http://127.0.0.1:7360")).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:7360",
      OTEL_LOG_TOOL_DETAILS: "1",
    });
  });
});

describe("prepareDatabase", () => {
  it("crea la base con sus migraciones y repetirlo no cambia nada", () => {
    const { dbPath } = options();
    prepareDatabase(dbPath).$client.close();
    const db = prepareDatabase(dbPath);
    const tables = db.$client
      .prepare("select name from sqlite_master where type = 'table' and name = 'projects'")
      .all();
    db.$client.close();
    expect(tables).toHaveLength(1);
  });
});

describe("startRuntime", () => {
  it("sirve el build del front end desde la misma URL cuando recibe webRoot", async () => {
    const opts = options();
    const webRoot = join(opts.dir, "web");
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>LunasQ</title>");
    const runtime = await start({ ...opts, webRoot });

    const home = await fetch(`${runtime.url}/queue`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("<title>LunasQ</title>");
    expect((await fetch(`${runtime.url}/api/projects`)).status).toBe(200);
  });

  it("pasa la cadencia del poll de PRs y del scheduler: una inválida impide arrancar", async () => {
    await expect(startRuntime(options({ prPollIntervalMs: 10 }))).rejects.toThrow(
      "intervalMs debe ser un entero >= 1000",
    );
    await expect(startRuntime(options({ scheduler: { tickIntervalMs: 10 } }))).rejects.toThrow();
    const runtime = await start(
      options({ prPollIntervalMs: 1_000, scheduler: { tickIntervalMs: 1_000 } }),
    );
    expect((await fetch(`${runtime.url}/api/queue`)).status).toBe(200);
  });

  it("sin webRoot no sirve estáticos", async () => {
    const runtime = await start(options());
    expect((await fetch(`${runtime.url}/queue`)).status).toBe(404);
  });

  it("sirve la API en localhost y escribe los archivos MCP y de hooks con su URL", async () => {
    const opts = options();
    const runtime = await start(opts);

    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${runtime.url}/api/projects`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);

    const mcp = JSON.parse(readFileSync(opts.mcpConfigPath, "utf8"));
    expect(mcp.mcpServers.lunasq.url).toBe(`${runtime.url}/mcp`);
    const settings = readFileSync(opts.hookSettingsPath, "utf8");
    expect(settings).toContain(`${runtime.url}${SUBAGENT_HOOK_PATH}`);
  });

  it("pasa la telemetría al entorno de cada pane salvo que se desactive", async () => {
    const opts = options();
    const seed = prepareDatabase(opts.dbPath);
    const task = insertTask(seed, insertProject(seed).id);
    seed.$client.close();
    const herdr = opts.adapters?.herdr as FakeHerdr;

    const on = await start(opts);

    const db = openDatabase(opts.dbPath);
    cleanups.push(() => {
      db.$client.close();
    });
    const runs = new RunRepository(db);
    await vi.waitFor(() => expect(runs.forTask(task.id)[0]?.herdrPane).toBeTruthy());
    const pane = runs.forTask(task.id)[0]?.herdrPane as string;
    expect(herdr.paneEnv(pane)).toMatchObject(telemetryEnv(on.url));

    // El endpoint OTLP responde con el flag activo: un token desconocido no tiene efectos.
    const logs = (url: string) => fetch(`${url}/v1/logs`, { method: "POST", body: "{}" });
    expect((await logs(on.url)).status).toBe(200);

    const off = await start(options({ telemetry: false }));
    expect(off.paneEnv).not.toHaveProperty("CLAUDE_CODE_ENABLE_TELEMETRY");
    expect((await logs(off.url)).status).toBe(404);
  });

  it("monta el stream de notificaciones", async () => {
    const runtime = await start(options());
    const controller = new AbortController();
    const res = await fetch(`${runtime.url}/api/notifications/stream`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });

  it("conecta la bandeja: agentes bloqueados, su acceso en herdr y la respuesta a preguntas", async () => {
    const opts = options();
    const seed = prepareDatabase(opts.dbPath);
    const project = insertProject(seed);
    const task = insertTask(seed, project.id);
    const waiting = insertTask(seed, project.id, {
      state: "in_progress",
      subState: "waiting_human",
    });
    const question = createQuestion(seed, {
      taskId: waiting.id,
      runId: insertRun(seed, waiting.id).id,
      question: "¿Borro la tabla?",
      context: "hay dos",
    });
    seed.$client.close();
    const herdr = opts.adapters?.herdr as FakeHerdr;
    const runtime = await start(opts);
    const db = openDatabase(opts.dbPath);
    cleanups.push(() => {
      db.$client.close();
    });
    const runs = new RunRepository(db);
    await vi.waitFor(() => expect(runs.forTask(task.id)[0]?.herdrName).toBeTruthy());
    const run = runs.forTask(task.id)[0];
    const name = run?.herdrName as string;

    herdr.setAgentStatus(name, "blocked");
    await vi.waitFor(async () => {
      const blocked = await (await fetch(`${runtime.url}/api/blocked`)).json();
      expect(blocked).toEqual([expect.objectContaining({ runId: run?.id, agentName: name })]);
    });
    const focus = await fetch(`${runtime.url}/api/blocked/${run?.id}/focus`, { method: "POST" });
    expect(focus.status).toBe(204);
    expect(herdr.focused).toBe(name);

    const answer = await fetch(`${runtime.url}/api/questions/${question.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "sí" }),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ delivery: "new_run" });
  });

  it("enfoca en herdr el agente de un Run despachado desde la tabla de Runs", async () => {
    const opts = options();
    const seed = prepareDatabase(opts.dbPath);
    const task = insertTask(seed, insertProject(seed).id);
    seed.$client.close();
    const herdr = opts.adapters?.herdr as FakeHerdr;
    const runtime = await start(opts);
    const db = openDatabase(opts.dbPath);
    cleanups.push(() => {
      db.$client.close();
    });
    const runs = new RunRepository(db);
    await vi.waitFor(() => expect(runs.forTask(task.id)[0]?.herdrPane).toBeTruthy());
    const run = runs.forTask(task.id)[0];

    const res = await fetch(`${runtime.url}/api/runs/${run?.id}/focus`, { method: "POST" });
    expect(res.status).toBe(204);
    expect(herdr.focused).toBe(run?.herdrName);
  });

  it("stop cierra el servidor y es idempotente", async () => {
    const runtime = await startRuntime(options());
    await runtime.stop();
    await runtime.stop();
    await expect(fetch(`${runtime.url}/api/projects`)).rejects.toThrow();
  });

  it("si la composición falla, libera el puerto y la base", async () => {
    const opts = options();
    const first = await start(options());
    const port = Number(new URL(first.url).port);
    await first.stop();
    const broken = {
      get herdr(): FakeHerdr {
        throw new Error("herdr roto");
      },
    };
    await expect(startRuntime({ ...opts, port, adapters: broken })).rejects.toThrow("herdr roto");
    const again = await start({ ...opts, port });
    expect(again.url).toBe(first.url);
  });

  it("falla si el puerto está ocupado", async () => {
    const first = await start(options());
    const port = Number(new URL(first.url).port);
    await expect(startRuntime(options({ port }))).rejects.toThrow(/EADDRINUSE/);
  });
});
