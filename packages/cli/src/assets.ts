// Phase skills and reviewer subagents that `install` copies to Claude Code (ADR uw-18-skills-fase,
// ADR uw-19-revisores). Each destination is left as an exact mirror of its source: a file that is no longer
// in the assets is deleted, so a new version does not leave old instructions. A manifest
// in `~/.lunasq/` records which destinations belong to LunasQ: a foreign folder with the same name is not
// touched, and that of a retired asset is deleted.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "./paths.ts";

/** The monorepo's `assets/`, seen from `packages/cli/src`. */
export function repoAssetsRoot(): string {
  return fileURLToPath(new URL("../../../assets/", import.meta.url));
}

/**
 * In the published package the assets sit next to the binary (`bin/../assets`); in the repo, at the
 * monorepo root.
 */
export function findAssetsRoot(): string {
  const candidates = [fileURLToPath(new URL("../assets/", import.meta.url)), repoAssetsRoot()];
  const found = candidates.find((dir) => existsSync(join(dir, "skills")));
  if (!found) throw new Error(`cannot find the LunasQ assets in ${candidates.join(" or in ")}`);
  return found;
}

/**
 * Front end build: next to the binary in the published package (`bin/../web`) or in
 * `packages/web/dist/app` of the repo. Without a build, `start` serves only the API.
 */
export function findWebRoot(): string | undefined {
  const candidates = [fileURLToPath(new URL("../web/", import.meta.url))];
  // Only in the repo: in an installed package `../../web` would belong to another package.
  const repoWeb = fileURLToPath(new URL("../../web/", import.meta.url));
  if (existsSync(join(repoWeb, "vite.config.ts"))) candidates.push(join(repoWeb, "dist", "app"));
  return candidates.find((dir) => existsSync(join(dir, "index.html")));
}

export interface AssetTarget {
  kind: "skill" | "agents" | "copilot-skill" | "copilot-agents";
  name: string;
  src: string;
  dest: string;
}

/** Each skill is a folder with `SKILL.md`; the reviewers go together in `agents/lunasq/`. */
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
    ...skills.map((name) => ({
      kind: "copilot-skill" as const,
      name,
      src: join(skillsRoot, name),
      dest: join(paths.copilotSkills, name),
    })),
    { kind: "agents", name: "lunasq", src: join(root, "agents", "lunasq"), dest: paths.agents },
    {
      kind: "copilot-agents",
      name: "lunasq",
      src: join(root, "agents", "copilot"),
      dest: paths.copilotAgents,
    },
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

/** Files that are missing, changed or left over in `dest`, relative to the folder. */
export async function drift(src: string, dest: string): Promise<string[]> {
  const [want, have] = await Promise.all([files(src), files(dest)]);
  const changed: string[] = [];
  for (const file of want) {
    if (!(await sameContent(join(src, file), join(dest, file)))) changed.push(file);
  }
  const extra = have.filter((f) => !want.includes(f));
  return [...changed, ...extra].sort();
}

/** Leaves `dest` equal to `src`; returns what it had to change (empty if it was already up to date). */
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

/** Destinations LunasQ installed (absolute paths); empty if it never installed. */
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
 * `foreign`: the destination exists, LunasQ did not install it and it is not identical to the assets (e.g. a
 * user's own skill with the same name). An identical one is adopted.
 */
export async function isForeign(target: AssetTarget, manifest: string[]): Promise<boolean> {
  if (manifest.includes(target.dest) || !existsSync(target.dest)) return false;
  return (await drift(target.src, target.dest)).length > 0;
}

/** Manifest destinations that no longer match any asset (a retired skill). */
export function retired(targets: AssetTarget[], manifest: string[]): string[] {
  const current = new Set(targets.map((t) => t.dest));
  return manifest.filter((dest) => !current.has(dest));
}

export interface SyncAssetsResult {
  changes: string[];
  foreign: string[];
}

/** Mirrors published assets onto destinations LunasQ owns and reports foreign destinations untouched. */
export async function syncAssets(root: string, paths: Paths): Promise<SyncAssetsResult> {
  const targets = await assetTargets(root, paths);
  const manifest = await readManifest(paths.manifest);
  const installed = new Set(manifest);
  const changes: string[] = [];
  const foreign: string[] = [];

  for (const target of targets) {
    if (await isForeign(target, manifest)) {
      foreign.push(target.dest);
      continue;
    }
    const changed = await mirror(target.src, target.dest);
    installed.add(target.dest);
    if (changed.length > 0) {
      const label =
        target.kind === "agents"
          ? "reviewer subagents"
          : target.kind === "copilot-agents"
            ? "reviewer subagents for Copilot CLI"
            : `skill ${target.name}${target.kind === "copilot-skill" ? " for Copilot" : ""}`;
      changes.push(`${label} → ${target.dest}`);
    }
  }

  for (const dest of retired(targets, manifest)) {
    await rm(dest, { recursive: true, force: true });
    installed.delete(dest);
    changes.push(`retired asset removed: ${dest}`);
  }

  const sorted = [...installed].sort();
  if (sorted.join("\n") !== [...manifest].sort().join("\n")) {
    await writeManifest(paths.manifest, sorted);
  }
  return { changes, foreign };
}
