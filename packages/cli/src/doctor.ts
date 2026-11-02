// `lunasq doctor`: each requirement of a machine ready for LunasQ (ADR uw-28-instalador). A
// failure prevents working; a warning does not (e.g. engram, which is optional). Green = no failures.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { hookSettings, mcpConfig, runtimeUrls } from "@lunasq/server";
import { assetTargets, drift, isForeign, readManifest, retired } from "./assets.ts";
import { baseUrl, ConfigError, type LunasqConfig, readConfig } from "./config.ts";
import { type MachineContext, NOT_FOUND_EXIT_CODE, run } from "./context.ts";
import { hasCopilotMcpConfig } from "./copilot-mcp.ts";
import { tomlString } from "./toml.ts";
import { compareVersions, parseVersion } from "./versions.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  summary: string;
  /** What to do to resolve it. */
  fix?: string;
}

/** Minimum versions verified in the spikes (ADR 0002, ADR 0003, ADR 0004, ADR uw-19-revisores). */
export const MINIMUM = {
  node: "26.0.0",
  herdr: "0.9.5",
  herdrProtocol: 22,
  claude: "2.1.312",
  copilot: "1.0.0",
  codex: "0.122.0",
} as const;

const INSTALL_FIX = "corre `lunasq install`";

const ok = (id: string, summary: string): CheckResult => ({ id, status: "ok", summary });
const warn = (id: string, summary: string, fix?: string): CheckResult => ({
  id,
  status: "warn",
  summary,
  ...(fix && { fix }),
});
const fail = (id: string, summary: string, fix?: string): CheckResult => ({
  id,
  status: "fail",
  summary,
  ...(fix && { fix }),
});

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function checkNode(ctx: MachineContext): CheckResult {
  const version = ctx.nodeVersion;
  if (compareVersions(version, MINIMUM.node) < 0) {
    return fail(
      "node",
      `Node.js ${version}; LunasQ needs ${MINIMUM.node} or newer`,
      "instala Node.js 26 LTS",
    );
  }
  return ok("node", `Node.js ${version}`);
}

export function checkSqlite(ctx: MachineContext): CheckResult {
  try {
    ctx.checkSqlite();
    return ok("sqlite", "better-sqlite3 loads and the migrations apply");
  } catch (err) {
    return fail(
      "sqlite",
      `better-sqlite3 no carga: ${message(err)}`,
      "reinstall lunasq on a platform with a better-sqlite3 prebuild (ADR 0003)",
    );
  }
}

interface HerdrStatus {
  client?: { version?: string; protocol?: number };
  server?: { running?: boolean; compatible?: boolean; version?: string };
}

export async function checkHerdr(ctx: MachineContext): Promise<CheckResult[]> {
  const res = await run(ctx, "herdr status --json");
  if (res.exitCode === NOT_FOUND_EXIT_CODE) {
    return [fail("herdr", "herdr is not installed", "install herdr 0.9.5 or newer")];
  }
  let status: HerdrStatus;
  try {
    status = JSON.parse(res.stdout) as HerdrStatus;
  } catch {
    return [
      fail(
        "herdr",
        `\`herdr status --json\` did not return JSON: ${res.stderr.trim() || res.stdout.trim()}`,
      ),
    ];
  }
  const version = status.client?.version ?? "";
  const protocol = status.client?.protocol;
  if (!parseVersion(version) || compareVersions(version, MINIMUM.herdr) < 0) {
    return [
      fail(
        "herdr",
        `herdr ${version || "unknown"}; LunasQ needs ${MINIMUM.herdr} or newer`,
        "actualiza herdr",
      ),
    ];
  }
  const results = [
    protocol === MINIMUM.herdrProtocol
      ? ok("herdr", `herdr ${version} (protocol ${protocol})`)
      : warn(
          "herdr",
          `herdr ${version} speaks protocol ${protocol}; LunasQ was verified with ${MINIMUM.herdrProtocol}`,
        ),
  ];
  if (!status.server?.running) {
    results.push(
      warn("herdr-server", "the herdr server is not running", "open herdr before `lunasq start`"),
    );
  } else if (status.server.compatible === false) {
    results.push(
      fail(
        "herdr-server",
        `the herdr server (${status.server.version}) is not compatible with the client`,
        "reinicia herdr",
      ),
    );
  } else {
    results.push(ok("herdr-server", "herdr server running"));
  }
  return results;
}

/** State of the official herdr integration for Claude Code (`herdr integration status`). */
export async function claudeIntegrationState(ctx: MachineContext): Promise<string | undefined> {
  const res = await run(ctx, "herdr integration status");
  if (res.exitCode !== 0) return undefined;
  return /^claude:\s*(.+?)(?:\s+\(\/.*\))?\s*$/m.exec(res.stdout)?.[1];
}

export async function checkHerdrIntegration(ctx: MachineContext): Promise<CheckResult> {
  if (
    (await checkClaude(ctx)).status !== "ok" &&
    ((await checkCopilot(ctx)).status === "ok" || (await checkCodex(ctx)).status === "ok")
  ) {
    return warn(
      "herdr-integration",
      "herdr integration for Claude Code skipped: a non-Claude provider is available",
    );
  }
  const state = await claudeIntegrationState(ctx);
  if (state?.startsWith("current"))
    return ok("herdr-integration", `herdr integration for Claude Code: ${state}`);
  return fail(
    "herdr-integration",
    `herdr integration for Claude Code: ${state ?? "unknown"}`,
    INSTALL_FIX,
  );
}

/** ADR 0009: with `ui.toast.delivery = "off"` (herdr's default) the notifications are not visible. */
export async function checkHerdrToast(ctx: MachineContext): Promise<CheckResult> {
  const text = await readFile(ctx.paths.herdrConfig, "utf8").catch(() => "");
  const delivery = tomlString(text, "ui.toast.delivery") ?? "off";
  if (delivery === "off") {
    return warn(
      "herdr-toast",
      'herdr notifications are off (`[ui.toast] delivery = "off"`); they will only reach the UI',
      `set \`delivery\` in the \`[ui.toast]\` section of ${ctx.paths.herdrConfig}`,
    );
  }
  return ok("herdr-toast", `herdr notifications: ${delivery}`);
}

export async function checkClaude(ctx: MachineContext): Promise<CheckResult> {
  const res = await run(ctx, "claude --version");
  if (res.exitCode === NOT_FOUND_EXIT_CODE) {
    return fail("claude", "Claude Code is not installed", "install Claude Code");
  }
  const version = parseVersion(res.stdout);
  if (res.exitCode !== 0 || !version) {
    return fail("claude", `\`claude --version\` failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  if (compareVersions(version, MINIMUM.claude) < 0) {
    return fail(
      "claude",
      `Claude Code ${version}; LunasQ needs ${MINIMUM.claude} or newer`,
      "actualiza Claude Code",
    );
  }
  return ok("claude", `Claude Code ${version}`);
}

export async function checkCopilot(ctx: MachineContext): Promise<CheckResult> {
  const res = await run(ctx, "copilot --version");
  if (res.exitCode === NOT_FOUND_EXIT_CODE) {
    return fail("copilot", "GitHub Copilot CLI is not installed", "install GitHub Copilot CLI");
  }
  const version = parseVersion(res.stdout);
  if (res.exitCode !== 0 || !version) {
    return fail(
      "copilot",
      `\`copilot --version\` failed: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  if (compareVersions(version, MINIMUM.copilot) < 0) {
    return fail(
      "copilot",
      `GitHub Copilot CLI ${version}; LunasQ needs ${MINIMUM.copilot} or newer`,
      "actualiza GitHub Copilot CLI",
    );
  }
  return ok("copilot", `GitHub Copilot CLI ${version}`);
}

export async function checkCodex(ctx: MachineContext): Promise<CheckResult> {
  const res = await run(ctx, "codex --version");
  if (res.exitCode === NOT_FOUND_EXIT_CODE) {
    return fail("codex", "OpenAI Codex CLI is not installed", "install OpenAI Codex CLI");
  }
  const version = parseVersion(res.stdout);
  if (res.exitCode !== 0 || !version) {
    return fail("codex", `\`codex --version\` failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  if (compareVersions(version, MINIMUM.codex) < 0) {
    return fail(
      "codex",
      `OpenAI Codex CLI ${version}; LunasQ needs ${MINIMUM.codex} or newer`,
      "actualiza OpenAI Codex CLI",
    );
  }
  return ok("codex", `OpenAI Codex CLI ${version}`);
}

export async function checkGh(ctx: MachineContext): Promise<CheckResult> {
  const res = await run(ctx, "gh auth status");
  if (res.exitCode === NOT_FOUND_EXIT_CODE)
    return fail("gh", "gh is not installed", "install GitHub CLI");
  if (res.exitCode !== 0)
    return fail("gh", "gh has no authenticated session", "run `gh auth login`");
  return ok("gh", "gh autenticado");
}

/** Tools LunasQ does not install: without them `install` does not continue. */
export async function checkPrerequisites(ctx: MachineContext): Promise<CheckResult[]> {
  const [herdr, claude, copilot, codex, gh] = await Promise.all([
    checkHerdr(ctx),
    checkClaude(ctx),
    checkCopilot(ctx),
    checkCodex(ctx),
    checkGh(ctx),
  ]);
  const providers = [claude, copilot, codex];
  if (providers.some((provider) => provider.status === "ok")) {
    for (const provider of providers) {
      if (provider.status !== "ok") provider.status = "warn";
    }
  }
  return [...herdr, ...providers, gh];
}

/** Fix for a foreign destination: LunasQ does not overwrite it (ADR uw-28-instalador). */
export const foreignFix = (dest: string) =>
  `${dest} was not installed by LunasQ: move or delete it and run \`lunasq install\``;

export async function checkAssets(ctx: MachineContext): Promise<CheckResult[]> {
  const targets = await assetTargets(ctx.assetsRoot, ctx.paths);
  const manifest = await readManifest(ctx.paths.manifest);
  const current = await Promise.all(
    targets.map(async (t) => {
      const id =
        t.kind === "agents"
          ? "agents"
          : t.kind === "copilot-agents"
            ? "copilot-agents"
            : `${t.kind === "copilot-skill" ? "copilot-skill" : "skill"}:${t.name}`;
      const label =
        t.kind === "agents"
          ? "reviewer subagents"
          : t.kind === "copilot-agents"
            ? "reviewer subagents for Copilot CLI"
            : `skill ${t.name}${t.kind === "copilot-skill" ? " for Copilot" : ""}`;
      if (await isForeign(t, manifest)) {
        return fail(
          id,
          `${label}: ${t.dest} already exists and does not belong to LunasQ`,
          foreignFix(t.dest),
        );
      }
      const changes = await drift(t.src, t.dest);
      if (changes.length === 0) return ok(id, `${label} en ${t.dest}`);
      const state = existsSync(t.dest) ? `outdated (${changes.join(", ")})` : "not installed";
      return fail(id, `${label}: ${state}`, INSTALL_FIX);
    }),
  );
  const leftovers = retired(targets, manifest)
    .filter((dest) => existsSync(dest))
    .map((dest) =>
      fail(`retired:${dest}`, `retired asset is still installed in ${dest}`, INSTALL_FIX),
    );
  return [...current, ...leftovers];
}

async function sameJson(path: string, expected: unknown): Promise<boolean> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return false;
  try {
    return isDeepStrictEqual(JSON.parse(text), expected);
  } catch {
    return false;
  }
}

/** Configuration, stable MCP file (the LunasQ MCP registration) and hook settings. */
export async function checkLunasqFiles(ctx: MachineContext): Promise<CheckResult[]> {
  let config: LunasqConfig | undefined;
  try {
    config = await readConfig(ctx.paths.config);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return [fail("config", `invalid configuration: ${err.message}`, `fix ${ctx.paths.config}`)];
  }
  if (!config) return [fail("config", "LunasQ is not installed", INSTALL_FIX)];
  const urls = runtimeUrls(baseUrl(config));
  const mcp = (await sameJson(ctx.paths.mcpConfig, mcpConfig(urls.mcp)))
    ? ok("mcp", `LunasQ MCP registered in ${ctx.paths.mcpConfig} (${urls.mcp})`)
    : fail(
        "mcp",
        "the LunasQ MCP file is missing or does not match the configuration",
        INSTALL_FIX,
      );
  const hooks = (await sameJson(ctx.paths.hookSettings, hookSettings(urls.hooks)))
    ? ok("hooks", `subagent hooks in ${ctx.paths.hookSettings}`)
    : fail(
        "hooks",
        "the hooks settings are missing or do not match the configuration",
        INSTALL_FIX,
      );
  const telemetry = config.telemetry
    ? ok("telemetry", `Claude Code telemetry to ${baseUrl(config)}`)
    : warn(
        "telemetry",
        "telemetry is off: there will be no per-task usage",
        `set \`telemetry: true\` in ${ctx.paths.config}`,
      );
  const copilotMcp = (await hasCopilotMcpConfig(ctx.paths.copilotMcpConfig, urls.mcp))
    ? ok("copilot-mcp", `LunasQ MCP registered in ${ctx.paths.copilotMcpConfig}`)
    : fail("copilot-mcp", "LunasQ MCP is not registered in the Copilot configuration", INSTALL_FIX);
  return [
    ok("config", `configuration in ${ctx.paths.config} (port ${config.port})`),
    mcp,
    copilotMcp,
    hooks,
    telemetry,
  ];
}

export async function checkEngram(ctx: MachineContext): Promise<CheckResult> {
  const res = await run(ctx, "command -v engram");
  if (res.exitCode === 0) return ok("engram", "engram instalado");
  return warn(
    "engram",
    "engram is not installed: agents work without persistent memory (optional)",
  );
}

export async function runDoctor(ctx: MachineContext): Promise<CheckResult[]> {
  const [prereqs, integration, toast, assets, files, engram] = await Promise.all([
    checkPrerequisites(ctx),
    checkHerdrIntegration(ctx),
    checkHerdrToast(ctx),
    checkAssets(ctx),
    checkLunasqFiles(ctx),
    checkEngram(ctx),
  ]);
  return [
    checkNode(ctx),
    checkSqlite(ctx),
    ...prereqs,
    integration,
    toast,
    ...assets,
    ...files,
    engram,
  ];
}

export const isGreen = (results: CheckResult[]) => results.every((r) => r.status !== "fail");

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatResults(results: CheckResult[]): string {
  return results
    .map((r) => `${MARK[r.status]} ${r.summary}${r.fix ? `\n    → ${r.fix}` : ""}`)
    .join("\n");
}
