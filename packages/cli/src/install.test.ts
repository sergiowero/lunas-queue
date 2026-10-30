import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpConfig } from "@lunasq/server";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PORT, readConfig } from "./config.ts";
import { install } from "./install.ts";
import { fakeMachine, healthyResponses, integrationStatus } from "./test-helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function cleanMachine(responses = healthyResponses()) {
  const m = fakeMachine({
    ...responses,
    "herdr integration status": integrationStatus("not installed"),
  });
  cleanups.push(m.cleanup);
  // La integración queda instalada cuando herdr la instala.
  m.responses["herdr integration install claude"] = { stdout: "installed" };
  const original = m.runner.run.bind(m.runner);
  m.runner.run = async (input) => {
    const res = await original(input);
    if (input.command === "herdr integration install claude") {
      m.responses["herdr integration status"] = integrationStatus("current (v11)");
    }
    return res;
  };
  return m;
}

describe("install", () => {
  it("deja una máquina limpia lista en un solo comando y doctor en verde", async () => {
    const { ctx, commands } = cleanMachine();
    const result = await install(ctx);

    expect(result.stage).toBe("done");
    expect(result.ok).toBe(true);
    expect(result.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(commands()).toContain("herdr integration install claude");

    expect(readdirSync(ctx.paths.skills).sort()).toEqual([
      "implement-task",
      "refine-task",
      "verify-task",
    ]);
    expect(readdirSync(ctx.paths.agents).sort()).toEqual([
      "lunasq-code-reviewer.md",
      "lunasq-security-reviewer.md",
      "lunasq-ui-reviewer.md",
      "lunasq-ux-reviewer.md",
    ]);
    expect(await readConfig(ctx.paths.config)).toEqual({ port: DEFAULT_PORT, telemetry: true });
    expect(JSON.parse(readFileSync(ctx.paths.mcpConfig, "utf8"))).toEqual(
      mcpConfig(`http://127.0.0.1:${DEFAULT_PORT}/mcp`),
    );
    expect(readFileSync(ctx.paths.hookSettings, "utf8")).toContain(
      `http://127.0.0.1:${DEFAULT_PORT}/hooks/subagent`,
    );
    expect(existsSync(ctx.paths.db)).toBe(true);
  });

  it("crea el directorio de Claude Code antes de instalar la integración de herdr", async () => {
    const { ctx, runner } = cleanMachine();
    let existed: boolean | undefined;
    const run = runner.run.bind(runner);
    runner.run = async (input) => {
      if (input.command === "herdr integration install claude")
        existed = existsSync(ctx.paths.claudeHome);
      return run(input);
    };
    await install(ctx);
    expect(existed).toBe(true);
  });

  it("repetirlo no cambia nada", async () => {
    const { ctx, commands } = cleanMachine();
    await install(ctx);
    const before = commands().length;

    const again = await install(ctx);
    expect(again.changes).toEqual([]);
    expect(again.ok).toBe(true);
    expect(commands().slice(before)).not.toContain("herdr integration install claude");
  });

  it("restaura un asset editado y borra los que ya no existen", async () => {
    const { ctx } = cleanMachine();
    await install(ctx);
    writeFileSync(join(ctx.paths.agents, "lunasq-code-reviewer.md"), "editado");
    writeFileSync(join(ctx.paths.agents, "lunasq-viejo-reviewer.md"), "viejo");

    const result = await install(ctx);
    expect(result.changes).toEqual([`subagentes revisores → ${ctx.paths.agents}`]);
    expect(readFileSync(join(ctx.paths.agents, "lunasq-code-reviewer.md"), "utf8")).not.toBe(
      "editado",
    );
    expect(existsSync(join(ctx.paths.agents, "lunasq-viejo-reviewer.md"))).toBe(false);
  });

  it("--port cambia el puerto y reescribe los archivos de Claude Code; sin él se conserva", async () => {
    const { ctx } = cleanMachine();
    await install(ctx, { port: 8123 });
    await install(ctx);
    expect((await readConfig(ctx.paths.config))?.port).toBe(8123);
    expect(readFileSync(ctx.paths.mcpConfig, "utf8")).toContain("http://127.0.0.1:8123/mcp");
  });

  it.each([
    ["herdr", "herdr status --json"],
    ["Claude Code", "claude --version"],
    ["gh", "gh auth status"],
  ])("sin %s no instala nada", async (_, command) => {
    const { ctx, commands } = cleanMachine({ ...healthyResponses(), [command]: { exitCode: 127 } });
    const result = await install(ctx);

    expect(result).toMatchObject({ stage: "prerequisites", ok: false, changes: [] });
    expect(result.checks.some((c) => c.status === "fail")).toBe(true);
    expect(commands()).not.toContain("herdr integration install claude");
    expect(existsSync(ctx.paths.home)).toBe(false);
    expect(existsSync(ctx.paths.claudeHome)).toBe(false);
  });

  it("si herdr no puede instalar la integración, lo dice", async () => {
    const m = fakeMachine({
      ...healthyResponses(),
      "herdr integration status": integrationStatus("not installed"),
      "herdr integration install claude": { exitCode: 1, stderr: "permission denied" },
    });
    cleanups.push(m.cleanup);
    await expect(install(m.ctx)).rejects.toThrow(/permission denied/);
  });
});
