// Skills de fase y subagentes revisores que `install` copia a Claude Code (ADR uw-18-skills-fase,
// ADR uw-19-revisores). Cada destino queda como espejo exacto de su origen: un archivo que ya no
// está en los assets se borra, así una versión nueva no deja instrucciones viejas. Un manifiesto
// en `~/.lunasq/` registra qué destinos son de LunasQ: una carpeta ajena con el mismo nombre no se
// toca, y la de un asset retirado se borra.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "./paths.ts";

/** `assets/` del monorepo, visto desde `packages/cli/src`. */
export function repoAssetsRoot(): string {
  return fileURLToPath(new URL("../../../assets/", import.meta.url));
}

/**
 * En el paquete publicado los assets van junto al binario (`bin/../assets`); en el repo, en la
 * raíz del monorepo.
 */
export function findAssetsRoot(): string {
  const candidates = [fileURLToPath(new URL("../assets/", import.meta.url)), repoAssetsRoot()];
  const found = candidates.find((dir) => existsSync(join(dir, "skills")));
  if (!found) throw new Error(`no encuentro los assets de LunasQ en ${candidates.join(" ni en ")}`);
  return found;
}

/**
 * Build del front end: junto al binario en el paquete publicado (`bin/../web`) o en
 * `packages/web/dist/app` del repo. Sin build, `start` sirve solo la API.
 */
export function findWebRoot(): string | undefined {
  const candidates = [fileURLToPath(new URL("../web/", import.meta.url))];
  // Solo en el repo: en un paquete instalado `../../web` sería de otro paquete.
  const repoWeb = fileURLToPath(new URL("../../web/", import.meta.url));
  if (existsSync(join(repoWeb, "vite.config.ts"))) candidates.push(join(repoWeb, "dist", "app"));
  return candidates.find((dir) => existsSync(join(dir, "index.html")));
}

export interface AssetTarget {
  kind: "skill" | "agents";
  name: string;
  src: string;
  dest: string;
}

/** Cada skill es una carpeta con `SKILL.md`; los revisores van juntos en `agents/lunasq/`. */
export async function assetTargets(root: string, paths: Paths): Promise<AssetTarget[]> {
  const skillsRoot = join(root, "skills");
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skills = entries
    .filter((e) => e.isDirectory() && existsSync(join(skillsRoot, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
  return [
    ...skills.map((name) => ({
      kind: "skill" as const,
      name,
      src: join(skillsRoot, name),
      dest: join(paths.skills, name),
    })),
    { kind: "agents", name: "lunasq", src: join(root, "agents", "lunasq"), dest: paths.agents },
  ];
}

async function files(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

async function sameContent(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([readFile(a), readFile(b).catch(() => undefined)]);
  return y !== undefined && x.equals(y);
}

/** Archivos que faltan, cambiaron o sobran en `dest`, relativos a la carpeta. */
export async function drift(src: string, dest: string): Promise<string[]> {
  const [want, have] = await Promise.all([files(src), files(dest)]);
  const changed: string[] = [];
  for (const file of want) {
    if (!(await sameContent(join(src, file), join(dest, file)))) changed.push(file);
  }
  const extra = have.filter((f) => !want.includes(f));
  return [...changed, ...extra].sort();
}

/** Deja `dest` igual a `src`; devuelve lo que tuvo que cambiar (vacío si ya estaba al día). */
export async function mirror(src: string, dest: string): Promise<string[]> {
  const changes = await drift(src, dest);
  const want = new Set(await files(src));
  for (const file of changes) {
    const target = join(dest, file);
    if (want.has(file)) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(src, file), target);
    } else {
      await rm(target, { force: true });
    }
  }
  return changes;
}

/** Destinos que instaló LunasQ (rutas absolutas); vacío si nunca instaló. */
export async function readManifest(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return [];
  try {
    const value = JSON.parse(text) as { installed?: unknown };
    return Array.isArray(value.installed)
      ? value.installed.filter((d): d is string => typeof d === "string")
      : [];
  } catch {
    return [];
  }
}

export async function writeManifest(path: string, installed: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ installed: [...installed].sort() }, null, 2)}\n`);
  await rename(tmp, path);
}

/**
 * `foreign`: el destino existe, LunasQ no lo instaló y no es idéntico a los assets (p. ej. una
 * skill propia del usuario con el mismo nombre). Uno idéntico se adopta.
 */
export async function isForeign(target: AssetTarget, manifest: string[]): Promise<boolean> {
  if (manifest.includes(target.dest) || !existsSync(target.dest)) return false;
  return (await drift(target.src, target.dest)).length > 0;
}

/** Destinos del manifiesto que ya no corresponden a ningún asset (una skill retirada). */
export function retired(targets: AssetTarget[], manifest: string[]): string[] {
  const current = new Set(targets.map((t) => t.dest));
  return manifest.filter((dest) => !current.has(dest));
}
