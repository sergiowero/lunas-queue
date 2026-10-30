// `lunasq install`: deja la máquina lista en un solo comando (ADR uw-28-instalador). Verifica
// herdr, Claude Code y gh (no los instala), instala la integración de herdr para Claude Code,
// copia skills y subagentes, escribe la configuración y los archivos estables para Claude Code,
// crea la base y termina con `doctor`. Repetirlo no cambia nada que ya esté al día.
import { mkdir, rm } from "node:fs/promises";
import { ensureHookSettings, ensureMcpConfig, prepareDatabase, runtimeUrls } from "@lunasq/server";
import { assetTargets, isForeign, mirror, readManifest, retired, writeManifest } from "./assets.ts";
import {
  baseUrl,
  ConfigError,
  DEFAULT_PORT,
  type LunasqConfig,
  readConfig,
  writeConfig,
} from "./config.ts";
import { type MachineContext, run } from "./context.ts";
import {
  type CheckResult,
  checkPrerequisites,
  claudeIntegrationState,
  isGreen,
  runDoctor,
} from "./doctor.ts";

export interface InstallOptions {
  /** Cambia el puerto guardado; sin él se conserva el actual (o el default en la primera vez). */
  port?: number;
}

export interface InstallResult {
  /** `prerequisites`: faltan herramientas y no se tocó nada; `done`: se instaló y corrió doctor. */
  stage: "prerequisites" | "done";
  /** Qué cambió, en orden; vacío si todo ya estaba al día. */
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
  // Antes de escribir nada: una configuración rota no deja la instalación a medias.
  let current: LunasqConfig | undefined;
  try {
    current = await readConfig(ctx.paths.config);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    throw new Error(`configuración inválida en ${ctx.paths.config}: ${err.message}`);
  }

  const changes: string[] = [];

  if (!(await claudeIntegrationState(ctx))?.startsWith("current")) {
    // herdr instala en `CLAUDE_CONFIG_DIR` (o ~/.claude) y falla si el directorio no existe.
    await mkdir(ctx.paths.claudeHome, { recursive: true });
    const res = await run(ctx, "herdr integration install claude");
    if (res.exitCode !== 0) {
      throw new Error(
        `\`herdr integration install claude\` falló: ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    changes.push("integración de herdr para Claude Code");
  }

  const targets = await assetTargets(ctx.assetsRoot, ctx.paths);
  const manifest = await readManifest(ctx.paths.manifest);
  const installed = new Set(manifest);
  for (const target of targets) {
    // Una carpeta ajena con el mismo nombre no se toca: doctor la reporta.
    if (await isForeign(target, manifest)) continue;
    const changed = await mirror(target.src, target.dest);
    installed.add(target.dest);
    if (changed.length > 0) {
      const label = target.kind === "skill" ? `skill ${target.name}` : "subagentes revisores";
      changes.push(`${label} → ${target.dest}`);
    }
  }
  for (const dest of retired(targets, manifest)) {
    await rm(dest, { recursive: true, force: true });
    installed.delete(dest);
    changes.push(`asset retirado borrado: ${dest}`);
  }
  const sorted = [...installed].sort();
  if (sorted.join("\n") !== [...manifest].sort().join("\n")) {
    await writeManifest(ctx.paths.manifest, sorted);
  }

  const config = {
    telemetry: current?.telemetry ?? true,
    port: opts.port ?? current?.port ?? DEFAULT_PORT,
  };
  if (!current || current.port !== config.port) {
    await writeConfig(ctx.paths.config, config);
    changes.push(`configuración → ${ctx.paths.config}`);
  }

  const urls = runtimeUrls(baseUrl(config));
  if ((await ensureMcpConfig(ctx.paths.mcpConfig, urls.mcp)).written) {
    changes.push(`LunasQ MCP → ${ctx.paths.mcpConfig}`);
  }
  if ((await ensureHookSettings(ctx.paths.hookSettings, urls.hooks)).written) {
    changes.push(`hooks de subagentes → ${ctx.paths.hookSettings}`);
  }

  await mkdir(ctx.paths.home, { recursive: true });
  prepareDatabase(ctx.paths.db).$client.close();

  const checks = await runDoctor(ctx);
  return { stage: "done", changes, checks, ok: isGreen(checks) };
}
