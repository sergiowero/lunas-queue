import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfig } from "./config.ts";
import { type CheckResult, isGreen, runDoctor } from "./doctor.ts";
import { install } from "./install.ts";
import { fakeMachine, HERDR_STATUS, healthyResponses, integrationStatus } from "./test-helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function machine(responses = healthyResponses()) {
  const m = fakeMachine(responses);
  cleanups.push(m.cleanup);
  return m;
}

const byId = (results: CheckResult[], id: string) => results.find((r) => r.id === id);

async function installed(responses = healthyResponses()) {
  const m = machine(responses);
  await install(m.ctx);
  return m;
}

describe("doctor", () => {
  it("una máquina recién instalada queda en verde", async () => {
    const { ctx } = await installed();
    const results = await runDoctor(ctx);
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(isGreen(results)).toBe(true);
    expect(results.map((r) => r.id)).toEqual([
      "node",
      "sqlite",
      "herdr",
      "herdr-server",
      "claude",
      "gh",
      "herdr-integration",
      "herdr-toast",
      "skill:implement-task",
      "skill:refine-task",
      "skill:verify-task",
      "agents",
      "config",
      "mcp",
      "hooks",
      "telemetry",
      "engram",
    ]);
  });

  it("una máquina limpia falla en lo que instala `lunasq install`", async () => {
    const { ctx } = machine({
      ...healthyResponses(),
      "herdr integration status": integrationStatus("not installed"),
    });
    const results = await runDoctor(ctx);
    const failed = results.filter((r) => r.status === "fail").map((r) => r.id);
    expect(failed).toEqual([
      "herdr-integration",
      "skill:implement-task",
      "skill:refine-task",
      "skill:verify-task",
      "agents",
      "config",
    ]);
    expect(
      results.filter((r) => r.status === "fail").every((r) => r.fix === "corre `lunasq install`"),
    ).toBe(true);
  });

  it("Node.js anterior a 26 falla", async () => {
    const { ctx } = await installed();
    ctx.nodeVersion = "25.8.2";
    expect(byId(await runDoctor(ctx), "node")?.status).toBe("fail");
  });

  it("better-sqlite3 que no carga falla", async () => {
    const { ctx } = await installed();
    ctx.checkSqlite = () => {
      throw new Error("invalid ELF header");
    };
    expect(byId(await runDoctor(ctx), "sqlite")).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("invalid ELF header"),
    });
  });

  it.each([
    ["no instalado", { exitCode: 127 }, "fail", /no está instalado/],
    [
      "viejo",
      { stdout: JSON.stringify({ client: { version: "0.9.4", protocol: 22 } }) },
      "fail",
      /0\.9\.5/,
    ],
    ["salida rota", { stdout: "nope", exitCode: 1 }, "fail", /no devolvió JSON/],
    [
      "otro protocol",
      { stdout: JSON.stringify({ ...HERDR_STATUS, client: { version: "0.10.0", protocol: 23 } }) },
      "warn",
      /protocol 23/,
    ],
  ])("herdr %s", async (_, response, status, summary) => {
    const { ctx } = machine({ ...healthyResponses(), "herdr status --json": response });
    expect(byId(await runDoctor(ctx), "herdr")).toMatchObject({
      status,
      summary: expect.stringMatching(summary),
    });
  });

  it("avisa si el servidor de herdr no corre y falla si no es compatible", async () => {
    const stopped = machine({
      ...healthyResponses(),
      "herdr status --json": {
        stdout: JSON.stringify({ ...HERDR_STATUS, server: { running: false } }),
      },
    });
    expect(byId(await runDoctor(stopped.ctx), "herdr-server")?.status).toBe("warn");
    const stale = machine({
      ...healthyResponses(),
      "herdr status --json": {
        stdout: JSON.stringify({
          ...HERDR_STATUS,
          server: { running: true, compatible: false, version: "0.9.4" },
        }),
      },
    });
    expect(byId(await runDoctor(stale.ctx), "herdr-server")?.status).toBe("fail");
  });

  it("una integración de herdr desactualizada falla", async () => {
    const { ctx, responses } = await installed();
    responses["herdr integration status"] = integrationStatus("outdated (v10, current v11)");
    expect(byId(await runDoctor(ctx), "herdr-integration")).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("outdated"),
    });
  });

  it("avisa con los toasts de herdr apagados (default) y no con otro delivery", async () => {
    const { ctx } = await installed();
    expect(byId(await runDoctor(ctx), "herdr-toast")?.status).toBe("warn");
    mkdirSync(dirname(ctx.paths.herdrConfig), { recursive: true });
    writeFileSync(ctx.paths.herdrConfig, '[ui.toast]\ndelivery = "system"\n');
    expect(byId(await runDoctor(ctx), "herdr-toast")?.status).toBe("ok");
  });

  it.each([
    ["no instalado", { exitCode: 127 }, /no está instalado/],
    ["viejo", { stdout: "2.1.200 (Claude Code)" }, /2\.1\.312/],
  ])("Claude Code %s falla", async (_, response, summary) => {
    const { ctx } = machine({ ...healthyResponses(), "claude --version": response });
    expect(byId(await runDoctor(ctx), "claude")).toMatchObject({
      status: "fail",
      summary: expect.stringMatching(summary),
    });
  });

  it("gh sin sesión falla con la instrucción para autenticarse", async () => {
    const { ctx } = machine({ ...healthyResponses(), "gh auth status": { exitCode: 1 } });
    expect(byId(await runDoctor(ctx), "gh")).toMatchObject({
      status: "fail",
      fix: "corre `gh auth login`",
    });
  });

  it("una skill modificada a mano falla como desactualizada", async () => {
    const { ctx } = await installed();
    writeFileSync(`${ctx.paths.skills}/verify-task/SKILL.md`, "editada");
    expect(byId(await runDoctor(ctx), "skill:verify-task")).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("desactualizado (SKILL.md)"),
    });
  });

  it("el archivo MCP debe apuntar al puerto configurado", async () => {
    const { ctx } = await installed();
    await writeConfig(ctx.paths.config, { port: 9999, telemetry: true });
    const results = await runDoctor(ctx);
    expect(byId(results, "mcp")?.status).toBe("fail");
    expect(byId(results, "hooks")?.status).toBe("fail");
  });

  it("una configuración inválida falla", async () => {
    const { ctx } = await installed();
    writeFileSync(ctx.paths.config, '{"port": -1}');
    expect(byId(await runDoctor(ctx), "config")?.status).toBe("fail");
  });

  it("sin engram solo avisa", async () => {
    const { ctx } = await installed({
      ...healthyResponses(),
      "command -v engram": { exitCode: 1 },
    });
    const results = await runDoctor(ctx);
    expect(byId(results, "engram")?.status).toBe("warn");
    expect(isGreen(results)).toBe(true);
  });
});
