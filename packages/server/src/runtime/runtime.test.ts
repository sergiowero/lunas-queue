import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGit, FakeGitHub, FakeHerdr, FakeProcessRunner } from "@lunasq/adapters";
import { afterEach, describe, expect, it } from "vitest";
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
    const on = await start(options());
    expect(on.paneEnv).toMatchObject(telemetryEnv(on.url));

    const off = await start(options({ telemetry: false }));
    expect(off.paneEnv).not.toHaveProperty("CLAUDE_CODE_ENABLE_TELEMETRY");
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

  it("stop cierra el servidor y es idempotente", async () => {
    const runtime = await startRuntime(options());
    await runtime.stop();
    await runtime.stop();
    await expect(fetch(`${runtime.url}/api/projects`)).rejects.toThrow();
  });

  it("falla si el puerto está ocupado", async () => {
    const first = await start(options());
    const port = Number(new URL(first.url).port);
    await expect(startRuntime(options({ port }))).rejects.toThrow(/EADDRINUSE/);
  });
});
