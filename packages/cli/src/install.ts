// `lunasq install`: leaves the machine ready in a single command (ADR uw-28-instalador). It verifies
// herdr, Claude Code and gh (it does not install them), installs the herdr integration for Claude Code,
// copies skills and subagents, writes the configuration and the stable files for Claude Code,
// creates the database and ends with `doctor`. Repeating it changes nothing that is already up to date.
import { mkdir } from "node:fs/promises";
import { ensureHookSettings, ensureMcpConfig, prepareDatabase, runtimeUrls } from "@lunasq/server";
import { syncAssets } from "./assets.ts";
import {
  baseUrl,
  ConfigError,
  DEFAULT_PORT,
  type LunasqConfig,
  readConfig,
  writeConfig,
} from "./config.ts";
import { type MachineContext, run } from "./context.ts";
import { ensureCopilotMcpConfig } from "./copilot-mcp.ts";
import {
  type CheckResult,
  checkPrerequisites,
  claudeIntegrationState,
  isGreen,
  runDoctor,
} from "./doctor.ts";

export interface InstallOptions {
  /** Changes the saved port; without it the current one is kept (or the default the first time). */
  port?: number;
}

export interface InstallResult {
  /** `prerequisites`: tools are missing and nothing was touched; `done`: it was installed and doctor ran. */
  stage: "prerequisites" | "done";
  /** What changed, in order; empty if everything was already up to date. */
  changes: string[];
  checks: CheckResult[];
  ok: boolean;
}

export async function install(
  ctx: MachineContext,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const prereqs = await checkPrerequisites(ctx);
  if (!isGreen(prereqs)) return { stage: "prerequisites", changes: [], checks: prereqs, ok: false };
  // Before writing anything: a broken configuration does not leave the installation half done.
  let current: LunasqConfig | undefined;
  try {
    current = await readConfig(ctx.paths.config);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    throw new Error(`invalid configuration in ${ctx.paths.config}: ${err.message}`);
  }

  const changes: string[] = [];

  const claudeCheck = prereqs.find((check) => check.id === "claude");
  if (claudeCheck?.status === "ok" && !(await claudeIntegrationState(ctx))?.startsWith("current")) {
    // herdr installs into `CLAUDE_CONFIG_DIR` (or ~/.claude) and fails if the directory does not exist.
    await mkdir(ctx.paths.claudeHome, { recursive: true });
    const res = await run(ctx, "herdr integration install claude");
    if (res.exitCode !== 0) {
      throw new Error(
        `\`herdr integration install claude\` failed: ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    changes.push("herdr integration for Claude Code");
  }

  changes.push(...(await syncAssets(ctx.assetsRoot, ctx.paths)).changes);

  const config = {
    telemetry: current?.telemetry ?? true,
    port: opts.port ?? current?.port ?? DEFAULT_PORT,
  };
  if (!current || current.port !== config.port) {
    await writeConfig(ctx.paths.config, config);
    changes.push(`configuration → ${ctx.paths.config}`);
  }

  const urls = runtimeUrls(baseUrl(config));
  if ((await ensureMcpConfig(ctx.paths.mcpConfig, urls.mcp)).written) {
    changes.push(`LunasQ MCP → ${ctx.paths.mcpConfig}`);
  }
  if ((await ensureCopilotMcpConfig(ctx.paths.copilotMcpConfig, urls.mcp)).written) {
    changes.push(`LunasQ MCP → ${ctx.paths.copilotMcpConfig}`);
  }
  if ((await ensureHookSettings(ctx.paths.hookSettings, urls.hooks)).written) {
    changes.push(`subagent hooks → ${ctx.paths.hookSettings}`);
  }

  await mkdir(ctx.paths.home, { recursive: true });
  prepareDatabase(ctx.paths.db).$client.close();

  const checks = await runDoctor(ctx);
  return { stage: "done", changes, checks, ok: isGreen(checks) };
}
