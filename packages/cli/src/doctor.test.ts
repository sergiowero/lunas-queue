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
  it("a freshly installed machine is green", async () => {
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
      "copilot",
      "codex",
      "gh",
      "herdr-integration",
      "herdr-toast",
      "skill:implement-task",
      "skill:refine-task",
      "skill:verify-task",
      "copilot-skill:implement-task",
      "copilot-skill:refine-task",
      "copilot-skill:verify-task",
      "agents",
      "copilot-agents",
      "config",
      "mcp",
      "copilot-mcp",
      "hooks",
      "telemetry",
      "engram",
    ]);
  });

  it("a clean machine fails on what `lunasq install` installs", async () => {
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
      "copilot-skill:implement-task",
      "copilot-skill:refine-task",
      "copilot-skill:verify-task",
      "agents",
      "copilot-agents",
      "config",
    ]);
    expect(
      results.filter((r) => r.status === "fail").every((r) => r.fix === "corre `lunasq install`"),
    ).toBe(true);
  });

  it("Node.js older than 26 fails", async () => {
    const { ctx } = await installed();
    ctx.nodeVersion = "25.8.2";
    expect(byId(await runDoctor(ctx), "node")?.status).toBe("fail");
  });

  it("better-sqlite3 that does not load fails", async () => {
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
    ["not installed", { exitCode: 127 }, "fail", /is not installed/],
    [
      "old",
      { stdout: JSON.stringify({ client: { version: "0.9.4", protocol: 22 } }) },
      "fail",
      /0\.9\.5/,
    ],
    ["broken output", { stdout: "nope", exitCode: 1 }, "fail", /did not return JSON/],
    [
      "another protocol",
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

  it("warns if the herdr server is not running and fails if it is not compatible", async () => {
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

  it("an outdated herdr integration fails", async () => {
    const { ctx, responses } = await installed();
    responses["herdr integration status"] = integrationStatus("outdated (v10, current v11)");
    expect(byId(await runDoctor(ctx), "herdr-integration")).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("outdated"),
    });
  });

  it("warns with herdr toasts off (default) and not with another delivery", async () => {
    const { ctx } = await installed();
    expect(byId(await runDoctor(ctx), "herdr-toast")?.status).toBe("warn");
    mkdirSync(dirname(ctx.paths.herdrConfig), { recursive: true });
    writeFileSync(ctx.paths.herdrConfig, '[ui.toast]\ndelivery = "system"\n');
    expect(byId(await runDoctor(ctx), "herdr-toast")?.status).toBe("ok");
  });

  it.each([
    ["not installed", { exitCode: 127 }, /is not installed/],
    ["old", { stdout: "2.1.200 (Claude Code)" }, /2\.1\.312/],
  ])("Claude Code %s warns while another provider is available", async (_, response, summary) => {
    const { ctx } = machine({
      ...healthyResponses(),
      "claude --version": response,
      "copilot --version": { exitCode: 127 },
    });
    expect(byId(await runDoctor(ctx), "claude")).toMatchObject({
      status: "warn",
      summary: expect.stringMatching(summary),
    });
  });

  it("Codex can be the only available agent provider", async () => {
    const { ctx } = machine({
      ...healthyResponses(),
      "claude --version": { exitCode: 127 },
      "copilot --version": { exitCode: 127 },
    });
    const results = await runDoctor(ctx);
    expect(byId(results, "claude")?.status).toBe("warn");
    expect(byId(results, "copilot")?.status).toBe("warn");
    expect(byId(results, "codex")?.status).toBe("ok");
    expect(byId(results, "herdr-integration")?.status).toBe("warn");
  });

  it("warns when Codex is unavailable but another provider is available", async () => {
    const { ctx } = machine({ ...healthyResponses(), "codex --version": { exitCode: 127 } });
    expect(byId(await runDoctor(ctx), "codex")).toMatchObject({
      status: "warn",
      summary: expect.stringContaining("not installed"),
    });
  });

  it("warns when Codex is older than its supported version", async () => {
    const { ctx } = machine({
      ...healthyResponses(),
      "codex --version": { stdout: "codex-cli 0.121.0" },
    });
    expect(byId(await runDoctor(ctx), "codex")).toMatchObject({
      status: "warn",
      summary: expect.stringContaining("0.122.0 or newer"),
    });
  });

  it("gh without a session fails with the instruction to authenticate", async () => {
    const { ctx } = machine({ ...healthyResponses(), "gh auth status": { exitCode: 1 } });
    expect(byId(await runDoctor(ctx), "gh")).toMatchObject({
      status: "fail",
      fix: "run `gh auth login`",
    });
  });

  it("a skill edited by hand fails as outdated", async () => {
    const { ctx } = await installed();
    writeFileSync(`${ctx.paths.skills}/verify-task/SKILL.md`, "editada");
    expect(byId(await runDoctor(ctx), "skill:verify-task")).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("outdated (SKILL.md)"),
    });
  });

  it("the MCP file must point to the configured port", async () => {
    const { ctx } = await installed();
    await writeConfig(ctx.paths.config, { port: 9999, telemetry: true });
    const results = await runDoctor(ctx);
    expect(byId(results, "mcp")?.status).toBe("fail");
    expect(byId(results, "hooks")?.status).toBe("fail");
  });

  it("an invalid configuration fails", async () => {
    const { ctx } = await installed();
    writeFileSync(ctx.paths.config, '{"port": -1}');
    expect(byId(await runDoctor(ctx), "config")?.status).toBe("fail");
  });

  it("without engram it only warns", async () => {
    const { ctx } = await installed({
      ...healthyResponses(),
      "command -v engram": { exitCode: 1 },
    });
    const results = await runDoctor(ctx);
    expect(byId(results, "engram")?.status).toBe("warn");
    expect(isGreen(results)).toBe(true);
  });
});
