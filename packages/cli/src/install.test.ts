import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpConfig } from "@lunasq/server";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PORT, readConfig } from "./config.ts";
import { runDoctor } from "./doctor.ts";
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
  // The integration is installed when herdr installs it.
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
  it("leaves a clean machine ready in a single command and doctor green", async () => {
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
    expect(readdirSync(ctx.paths.copilotSkills).sort()).toEqual([
      "implement-task",
      "refine-task",
      "verify-task",
    ]);
    expect(readdirSync(ctx.paths.copilotAgents).sort()).toEqual([
      "code-reviewer.agent.md",
      "security-reviewer.agent.md",
      "ui-reviewer.agent.md",
      "ux-reviewer.agent.md",
    ]);
    expect(
      readFileSync(join(ctx.paths.copilotAgents, "security-reviewer.agent.md"), "utf8"),
    ).toContain("name: lunasq-security-reviewer");
    expect(JSON.parse(readFileSync(ctx.paths.copilotMcpConfig, "utf8"))).toEqual({
      mcpServers: {
        lunasq: { type: "http", url: `http://127.0.0.1:${DEFAULT_PORT}/mcp` },
      },
    });
    expect(await readConfig(ctx.paths.config)).toEqual({ port: DEFAULT_PORT, telemetry: true });
    expect(JSON.parse(readFileSync(ctx.paths.mcpConfig, "utf8"))).toEqual(
      mcpConfig(`http://127.0.0.1:${DEFAULT_PORT}/mcp`),
    );
    expect(readFileSync(ctx.paths.hookSettings, "utf8")).toContain(
      `http://127.0.0.1:${DEFAULT_PORT}/hooks/subagent`,
    );
    expect(existsSync(ctx.paths.db)).toBe(true);
  });

  it("creates the Claude Code directory before installing the herdr integration", async () => {
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

  it("repeating it changes nothing", async () => {
    const { ctx, commands } = cleanMachine();
    await install(ctx);
    const before = commands().length;

    const again = await install(ctx);
    expect(again.changes).toEqual([]);
    expect(again.ok).toBe(true);
    expect(commands().slice(before)).not.toContain("herdr integration install claude");
  });

  it("registers MCP in Copilot preserving other options and servers", async () => {
    const { ctx } = cleanMachine();
    mkdirSync(ctx.paths.copilotHome, { recursive: true });
    writeFileSync(
      ctx.paths.copilotMcpConfig,
      JSON.stringify({
        customOption: true,
        mcpServers: { other: { type: "stdio", command: "other-mcp" } },
      }),
    );

    await install(ctx);

    expect(JSON.parse(readFileSync(ctx.paths.copilotMcpConfig, "utf8"))).toEqual({
      customOption: true,
      mcpServers: {
        other: { type: "stdio", command: "other-mcp" },
        lunasq: { type: "http", url: `http://127.0.0.1:${DEFAULT_PORT}/mcp` },
      },
    });
  });

  it("restores an edited asset and deletes the ones that no longer exist", async () => {
    const { ctx } = cleanMachine();
    await install(ctx);
    writeFileSync(join(ctx.paths.agents, "lunasq-code-reviewer.md"), "editado");
    writeFileSync(join(ctx.paths.agents, "lunasq-viejo-reviewer.md"), "viejo");

    const result = await install(ctx);
    expect(result.changes).toEqual([`reviewer subagents → ${ctx.paths.agents}`]);
    expect(readFileSync(join(ctx.paths.agents, "lunasq-code-reviewer.md"), "utf8")).not.toBe(
      "editado",
    );
    expect(existsSync(join(ctx.paths.agents, "lunasq-viejo-reviewer.md"))).toBe(false);
  });

  it("--port changes the port and rewrites the Claude Code files; without it the current one is kept", async () => {
    const { ctx } = cleanMachine();
    await install(ctx, { port: 8123 });
    await install(ctx);
    expect((await readConfig(ctx.paths.config))?.port).toBe(8123);
    expect(readFileSync(ctx.paths.mcpConfig, "utf8")).toContain("http://127.0.0.1:8123/mcp");
  });

  it("does not touch a foreign skill with the same name and doctor reports it", async () => {
    const { ctx } = cleanMachine();
    const mine = join(ctx.paths.skills, "implement-task");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "SKILL.md"), "mi skill");
    writeFileSync(join(mine, "notes.md"), "mis notas");

    const result = await install(ctx);

    expect(readFileSync(join(mine, "SKILL.md"), "utf8")).toBe("mi skill");
    expect(readFileSync(join(mine, "notes.md"), "utf8")).toBe("mis notas");
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "skill:implement-task")).toMatchObject({
      status: "fail",
      fix: expect.stringContaining("was not installed by LunasQ"),
    });
    // The rest are installed.
    expect(result.checks.find((c) => c.id === "skill:refine-task")?.status).toBe("ok");
  });

  it("adopts a destination identical to the assets", async () => {
    const { ctx } = cleanMachine();
    await install(ctx);
    rmSync(ctx.paths.manifest);
    const result = await install(ctx);
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(ctx.paths.manifest, "utf8")).installed).toContain(
      join(ctx.paths.skills, "verify-task"),
    );
  });

  it("deletes the folder of an asset that LunasQ installed and no longer publishes", async () => {
    const { ctx } = cleanMachine();
    await install(ctx);
    const old = join(ctx.paths.skills, "deliver-task");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "SKILL.md"), "vieja");
    const manifest = JSON.parse(readFileSync(ctx.paths.manifest, "utf8"));
    writeFileSync(ctx.paths.manifest, JSON.stringify({ installed: [...manifest.installed, old] }));
    expect((await runDoctor(ctx)).find((c) => c.id === `retired:${old}`)?.status).toBe("fail");

    const result = await install(ctx);

    expect(existsSync(old)).toBe(false);
    expect(result.changes).toEqual([`retired asset removed: ${old}`]);
    expect(result.ok).toBe(true);
  });

  it("an invalid configuration is reported with its path before writing anything", async () => {
    const { ctx } = cleanMachine();
    mkdirSync(ctx.paths.home, { recursive: true });
    writeFileSync(ctx.paths.config, "{");
    await expect(install(ctx)).rejects.toThrow(ctx.paths.config);
    expect(existsSync(ctx.paths.claudeHome)).toBe(false);
  });

  it.each([
    ["herdr", "herdr status --json"],
    ["both providers", "claude --version"],
    ["gh", "gh auth status"],
  ])("does not install anything without %s", async (_, command) => {
    const { ctx, commands } = cleanMachine({
      ...healthyResponses(),
      [command]: { exitCode: 127 },
      ...(command === "claude --version"
        ? { "copilot --version": { exitCode: 127 }, "codex --version": { exitCode: 127 } }
        : {}),
    });
    const result = await install(ctx);

    expect(result).toMatchObject({ stage: "prerequisites", ok: false, changes: [] });
    expect(result.checks.some((c) => c.status === "fail")).toBe(true);
    expect(commands()).not.toContain("herdr integration install claude");
    expect(existsSync(ctx.paths.home)).toBe(false);
    expect(existsSync(ctx.paths.claudeHome)).toBe(false);
  });

  it("if herdr cannot install the integration, it says so", async () => {
    const m = fakeMachine({
      ...healthyResponses(),
      "herdr integration status": integrationStatus("not installed"),
      "herdr integration install claude": { exitCode: 1, stderr: "permission denied" },
    });
    cleanups.push(m.cleanup);
    await expect(install(m.ctx)).rejects.toThrow(/permission denied/);
  });
});
