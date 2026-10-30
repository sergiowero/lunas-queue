import type { Runtime, RuntimeOptions } from "@lunasq/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeConfig } from "./config.ts";
import { install } from "./install.ts";
import { main, untilSignal, VERSION } from "./main.ts";
import { fakeMachine, healthyResponses } from "./test-helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function setup(responses = healthyResponses()) {
  const m = fakeMachine(responses);
  cleanups.push(m.cleanup);
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    context: () => m.ctx,
    out: (t: string) => out.push(t),
    err: (t: string) => err.push(t),
  };
  return { ...m, out, err, deps };
}

describe("lunasq", () => {
  it("--version y la ayuda salen con 0", async () => {
    const { deps, out } = setup();
    expect(await main(["--version"], deps)).toBe(0);
    expect(out).toEqual([VERSION]);
    expect(await main([], deps)).toBe(0);
    expect(out[1]).toContain("lunasq install");
  });

  it("un comando o una opción desconocidos salen con 2", async () => {
    const { deps, err } = setup();
    expect(await main(["deploy"], deps)).toBe(2);
    expect(await main(["doctor", "--nope"], deps)).toBe(2);
    expect(await main(["install", "--port", "70000"], deps)).toBe(2);
    expect(err.join("\n")).toContain("--port inválido");
  });

  it("install deja doctor en verde y sale con 0", async () => {
    const { deps, out } = setup();
    expect(await main(["install", "--port", "8124"], deps)).toBe(0);
    expect(out.join("\n")).toContain("Instalado:");
    expect(await main(["doctor"], deps)).toBe(0);
    expect(out.at(-1)).toContain("✓ LunasQ MCP registrado");
  });

  it("install sin requisitos sale con 1 y explica qué falta", async () => {
    const { deps, err } = setup({ ...healthyResponses(), "gh auth status": { exitCode: 127 } });
    expect(await main(["install"], deps)).toBe(1);
    expect(err.join("\n")).toContain("✗ gh no está instalado");
  });

  it("doctor sale con 1 si algo falla y --json da los resultados", async () => {
    const { deps, out } = setup();
    expect(await main(["doctor", "--json"], deps)).toBe(1);
    const results = JSON.parse(out[0] ?? "[]") as { id: string; status: string }[];
    expect(results.find((r) => r.id === "config")?.status).toBe("fail");
  });

  it("start sin instalar sale con 1", async () => {
    const { deps, err } = setup();
    expect(await main(["start"], deps)).toBe(1);
    expect(err.join("\n")).toContain("lunasq install");
  });

  it("start arranca con la configuración instalada y para al recibir la señal", async () => {
    const { deps, ctx, out } = setup();
    await install(ctx);
    await writeConfig(ctx.paths.config, { port: 8125, telemetry: false });
    const stop = vi.fn(async () => {});
    const startRuntime = vi.fn(
      async (_: RuntimeOptions): Promise<Runtime> => ({
        url: "http://127.0.0.1:8125",
        paneEnv: {},
        stop,
      }),
    );

    const code = await main(["start"], { ...deps, startRuntime, untilSignal: async () => {} });

    expect(code).toBe(0);
    expect(startRuntime.mock.calls[0]?.[0]).toMatchObject({
      dbPath: ctx.paths.db,
      port: 8125,
      mcpConfigPath: ctx.paths.mcpConfig,
      hookSettingsPath: ctx.paths.hookSettings,
      telemetry: false,
    });
    expect(out).toContain("LunasQ en http://127.0.0.1:8125");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("start sirve el front end cuando la máquina tiene su build", async () => {
    const { deps, ctx } = setup();
    await install(ctx);
    const startRuntime = vi.fn(
      async (_: RuntimeOptions): Promise<Runtime> => ({
        url: "http://x",
        paneEnv: {},
        stop: async () => {},
      }),
    );
    const context = () => ({ ...ctx, webRoot: "/srv/web" });
    await main(["start"], { ...deps, context, startRuntime, untilSignal: async () => {} });
    expect(startRuntime.mock.calls[0]?.[0]).toMatchObject({ webRoot: "/srv/web" });

    await main(["start"], { ...deps, startRuntime, untilSignal: async () => {} });
    expect(startRuntime.mock.calls[1]?.[0]).not.toHaveProperty("webRoot");
  });

  it("un error inesperado sale con 1 y su mensaje", async () => {
    const { deps, ctx, err } = setup();
    await install(ctx);
    const startRuntime = async (): Promise<Runtime> => {
      throw new Error("listen EADDRINUSE");
    };
    expect(await main(["start"], { ...deps, startRuntime })).toBe(1);
    expect(err).toContain("lunasq start: listen EADDRINUSE");
  });
});

describe("untilSignal", () => {
  it("resuelve con la primera señal y quita sus dos listeners", async () => {
    const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
    const waiting = untilSignal();
    process.emit("SIGINT");
    await waiting;
    expect(process.listenerCount("SIGINT")).toBe(before.int);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
  });
});
