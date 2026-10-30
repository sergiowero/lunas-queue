// `lunasq doctor`: cada requisito de una máquina lista para LunasQ (ADR uw-28-instalador). Una
// falla impide trabajar; un aviso no (p. ej. engram, que es opcional). Verde = ninguna falla.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { hookSettings, mcpConfig, runtimeUrls } from "@lunasq/server";
import { assetTargets, drift } from "./assets.ts";
import { baseUrl, ConfigError, type LunasqConfig, readConfig } from "./config.ts";
import { type MachineContext, NOT_FOUND_EXIT_CODE, run } from "./context.ts";
import { tomlString } from "./toml.ts";
import { compareVersions, parseVersion } from "./versions.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  summary: string;
  /** Qué hacer para resolverlo. */
  fix?: string;
}

/** Versiones mínimas verificadas en los spikes (ADR 0002, ADR 0003, ADR 0004, ADR uw-19-revisores). */
export const MINIMUM = {
  node: "26.0.0",
  herdr: "0.9.5",
  herdrProtocol: 22,
  claude: "2.1.312",
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
      `Node.js ${version}; LunasQ necesita ${MINIMUM.node} o más`,
      "instala Node.js 26 LTS",
    );
  }
  return ok("node", `Node.js ${version}`);
}

export function checkSqlite(ctx: MachineContext): CheckResult {
  try {
    ctx.checkSqlite();
    return ok("sqlite", "better-sqlite3 carga y las migraciones aplican");
  } catch (err) {
    return fail(
      "sqlite",
      `better-sqlite3 no carga: ${message(err)}`,
      "reinstala lunasq en una plataforma con prebuild de better-sqlite3 (ADR 0003)",
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
    return [fail("herdr", "herdr no está instalado", "instala herdr 0.9.5 o más")];
  }
  let status: HerdrStatus;
  try {
    status = JSON.parse(res.stdout) as HerdrStatus;
  } catch {
    return [
      fail(
        "herdr",
        `\`herdr status --json\` no devolvió JSON: ${res.stderr.trim() || res.stdout.trim()}`,
      ),
    ];
  }
  const version = status.client?.version ?? "";
  const protocol = status.client?.protocol;
  if (!parseVersion(version) || compareVersions(version, MINIMUM.herdr) < 0) {
    return [
      fail(
        "herdr",
        `herdr ${version || "desconocido"}; LunasQ necesita ${MINIMUM.herdr} o más`,
        "actualiza herdr",
      ),
    ];
  }
  const results = [
    protocol === MINIMUM.herdrProtocol
      ? ok("herdr", `herdr ${version} (protocol ${protocol})`)
      : warn(
          "herdr",
          `herdr ${version} habla protocol ${protocol}; LunasQ se verificó con ${MINIMUM.herdrProtocol}`,
        ),
  ];
  if (!status.server?.running) {
    results.push(
      warn(
        "herdr-server",
        "el servidor de herdr no está corriendo",
        "abre herdr antes de `lunasq start`",
      ),
    );
  } else if (status.server.compatible === false) {
    results.push(
      fail(
        "herdr-server",
        `el servidor de herdr (${status.server.version}) no es compatible con el cliente`,
        "reinicia herdr",
      ),
    );
  } else {
    results.push(ok("herdr-server", "servidor de herdr corriendo"));
  }
  return results;
}

/** Estado de la integración oficial de herdr para Claude Code (`herdr integration status`). */
export async function claudeIntegrationState(ctx: MachineContext): Promise<string | undefined> {
  const res = await run(ctx, "herdr integration status");
  if (res.exitCode !== 0) return undefined;
  return /^claude:\s*(.+?)(?:\s+\(\/.*\))?\s*$/m.exec(res.stdout)?.[1];
}

export async function checkHerdrIntegration(ctx: MachineContext): Promise<CheckResult> {
  const state = await claudeIntegrationState(ctx);
  if (state?.startsWith("current"))
    return ok("herdr-integration", `integración de herdr para Claude Code: ${state}`);
  return fail(
    "herdr-integration",
    `integración de herdr para Claude Code: ${state ?? "desconocida"}`,
    INSTALL_FIX,
  );
}

/** ADR 0009: con `ui.toast.delivery = "off"` (el default de herdr) las notificaciones no se ven. */
export async function checkHerdrToast(ctx: MachineContext): Promise<CheckResult> {
  const text = await readFile(ctx.paths.herdrConfig, "utf8").catch(() => "");
  const delivery = tomlString(text, "ui.toast.delivery") ?? "off";
  if (delivery === "off") {
    return warn(
      "herdr-toast",
      'los avisos de herdr están apagados (`[ui.toast] delivery = "off"`); solo llegarán a la UI',
      `define \`delivery\` en la sección \`[ui.toast]\` de ${ctx.paths.herdrConfig}`,
    );
  }
  return ok("herdr-toast", `avisos de herdr: ${delivery}`);
}

export async function checkClaude(ctx: MachineContext): Promise<CheckResult> {
  const res = await run(ctx, "claude --version");
  if (res.exitCode === NOT_FOUND_EXIT_CODE) {
    return fail("claude", "Claude Code no está instalado", "instala Claude Code");
  }
  const version = parseVersion(res.stdout);
  if (res.exitCode !== 0 || !version) {
    return fail("claude", `\`claude --version\` falló: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  if (compareVersions(version, MINIMUM.claude) < 0) {
    return fail(
      "claude",
      `Claude Code ${version}; LunasQ necesita ${MINIMUM.claude} o más`,
      "actualiza Claude Code",
    );
  }
  return ok("claude", `Claude Code ${version}`);
}

export async function checkGh(ctx: MachineContext): Promise<CheckResult> {
  const res = await run(ctx, "gh auth status");
  if (res.exitCode === NOT_FOUND_EXIT_CODE)
    return fail("gh", "gh no está instalado", "instala GitHub CLI");
  if (res.exitCode !== 0)
    return fail("gh", "gh no tiene una sesión autenticada", "corre `gh auth login`");
  return ok("gh", "gh autenticado");
}

/** Herramientas que LunasQ no instala: sin ellas `install` no sigue. */
export async function checkPrerequisites(ctx: MachineContext): Promise<CheckResult[]> {
  const [herdr, claude, gh] = await Promise.all([checkHerdr(ctx), checkClaude(ctx), checkGh(ctx)]);
  return [...herdr, claude, gh];
}

export async function checkAssets(ctx: MachineContext): Promise<CheckResult[]> {
  const targets = await assetTargets(ctx.assetsRoot, ctx.paths);
  return Promise.all(
    targets.map(async (t) => {
      const id = t.kind === "skill" ? `skill:${t.name}` : "agents";
      const label = t.kind === "skill" ? `skill ${t.name}` : "subagentes revisores";
      const changes = await drift(t.src, t.dest);
      if (changes.length === 0) return ok(id, `${label} en ${t.dest}`);
      const state = existsSync(t.dest) ? `desactualizado (${changes.join(", ")})` : "sin instalar";
      return fail(id, `${label}: ${state}`, INSTALL_FIX);
    }),
  );
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

/** Configuración, archivo MCP estable (el registro del LunasQ MCP) y settings de hooks. */
export async function checkLunasqFiles(ctx: MachineContext): Promise<CheckResult[]> {
  let config: LunasqConfig | undefined;
  try {
    config = await readConfig(ctx.paths.config);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return [
      fail("config", `configuración inválida: ${err.message}`, `corrige ${ctx.paths.config}`),
    ];
  }
  if (!config) return [fail("config", "LunasQ no está instalado", INSTALL_FIX)];
  const urls = runtimeUrls(baseUrl(config));
  const mcp = (await sameJson(ctx.paths.mcpConfig, mcpConfig(urls.mcp)))
    ? ok("mcp", `LunasQ MCP registrado en ${ctx.paths.mcpConfig} (${urls.mcp})`)
    : fail(
        "mcp",
        "el archivo MCP de LunasQ falta o no corresponde a la configuración",
        INSTALL_FIX,
      );
  const hooks = (await sameJson(ctx.paths.hookSettings, hookSettings(urls.hooks)))
    ? ok("hooks", `hooks de subagentes en ${ctx.paths.hookSettings}`)
    : fail("hooks", "el settings de hooks falta o no corresponde a la configuración", INSTALL_FIX);
  const telemetry = config.telemetry
    ? ok("telemetry", `telemetría de Claude Code hacia ${baseUrl(config)}`)
    : warn(
        "telemetry",
        "telemetría apagada: no habrá usage por tarea",
        `pon \`telemetry: true\` en ${ctx.paths.config}`,
      );
  return [
    ok("config", `configuración en ${ctx.paths.config} (puerto ${config.port})`),
    mcp,
    hooks,
    telemetry,
  ];
}

export async function checkEngram(ctx: MachineContext): Promise<CheckResult> {
  const res = await run(ctx, "command -v engram");
  if (res.exitCode === 0) return ok("engram", "engram instalado");
  return warn(
    "engram",
    "engram no está instalado: los agentes trabajan sin memoria persistente (opcional)",
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
