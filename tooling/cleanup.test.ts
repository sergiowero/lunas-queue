import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guards for the removal of the obsolete units-of-work backlog: the backlog stays gone,
// no reference to it comes back, and the ADRs in docs/decisions/ are kept.
const root = join(import.meta.dirname, "..");
const self = "tooling/cleanup.test.ts";

// Patterns are built from fragments so that this file never matches its own searches.
const archiveDir = ["docs", "archive"].join("/");
const backlogPatterns = [
  archiveDir,
  ["units", "of", "work"].join("-"),
  ["archive", "units"].join("/"),
];
const unitIdPattern = new RegExp(`${"UW"}-[0-9]+`);

/** The ADRs that docs/decisions held when the backlog was removed; every one of them must stay. */
const keptAdrs = [
  "0001-mcp-sdk.md",
  "0002-run-token-mcp-config.md",
  "0003-sqlite-driver-node26.md",
  "0004-herdr-version-y-cli.md",
  "0005-convenciones-esquema-sqlite.md",
  "0006-handoff-v1.md",
  "0007-maquina-de-estados.md",
  "0008-config-proyecto.md",
  "0009-notificaciones.md",
  "0010-api-tareas-dag.md",
  "0011-outbox.md",
  "0012-ciclo-de-vida-worktrees.md",
  "0013-specs-y-aprobacion.md",
  "0014-scheduler.md",
  "0015-bandeja-lista-de-specs.md",
  "0015-limite-de-uso-agente.md",
  "0015-numero-de-tarea.md",
  "0016-proveedores-agente.md",
  "effort-por-fase.md",
  "i18n-es-en.md",
  "pr-en-conflicto.md",
  "runs-foco-pane.md",
  "settings-proveedores.md",
  "tema-claro-oscuro.md",
  "uw-10-hooks.md",
  "uw-11-gate-tests.md",
  "uw-14-adapter-github.md",
  "uw-15-mcp-tools.md",
  "uw-16-dispatcher.md",
  "uw-17-reconciliacion.md",
  "uw-18-skills-fase.md",
  "uw-19-revisores.md",
  "uw-20-usage-collector.md",
  "uw-21-front-end.md",
  "uw-22-preguntas.md",
  "uw-23-verificacion.md",
  "uw-24-archivo-evidencia.md",
  "uw-25-vistas-dag-hooks.md",
  "uw-26-entrega.md",
  "uw-27-bandeja.md",
  "uw-28-instalador.md",
  "uw-29-e2e.md",
  "verdict-git-rework.md",
];

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** Tracked files that currently exist in the working tree. */
function trackedFiles(): string[] {
  return git("ls-files", "-z")
    .split("\0")
    .filter((file) => file !== "" && existsSync(join(root, file)));
}

function filesMatching(files: string[], pattern: string | RegExp): string[] {
  return files.filter((file) => {
    const text = readFileSync(join(root, file), "utf8");
    return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
  });
}

/** Binary files cannot hold a textual reference and are slow to read. */
function isText(file: string): boolean {
  return !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|gz|zip)$/i.test(file);
}

describe("units-of-work backlog removal", () => {
  const files = trackedFiles().filter(isText);

  it("docs/archive no longer exists and docs/decisions keeps all its ADRs", () => {
    expect(existsSync(join(root, archiveDir))).toBe(false);
    const decisions = readdirSync(join(root, "docs", "decisions"));
    expect(keptAdrs).toHaveLength(43);
    expect(keptAdrs.filter((name) => !decisions.includes(name))).toEqual([]);
  });

  it.each(backlogPatterns)("nothing outside lunasq/tasks mentions «%s»", (pattern) => {
    const candidates = files.filter((file) => file !== self && !file.startsWith("lunasq/tasks/"));
    expect(filesMatching(candidates, pattern)).toEqual([]);
  });

  it("no unit-of-work id remains outside the ADRs, the task evidence and the recorded spike outputs", () => {
    const candidates = files.filter(
      (file) =>
        file !== self &&
        !file.startsWith("docs/decisions/") &&
        !file.startsWith("lunasq/tasks/") &&
        !/^spikes\/[^/]+\/outputs\//.test(file),
    );
    expect(filesMatching(candidates, unitIdPattern)).toEqual([]);
  });
});

/** Non-test source code: TypeScript/JavaScript outside test files, test folders and fixtures. */
function isProductionCode(file: string): boolean {
  return (
    /\.(tsx?|jsx?|mjs|cjs)$/.test(file) &&
    !/\.(test|spec)\.[^/]+$/.test(file) &&
    !/(^|\/)(test|tests|__tests__|fixtures)\//.test(file) &&
    !/^spikes\/[^/]+\/outputs\//.test(file)
  );
}

/** Lines of a unified diff that add or remove something other than a comment or a blank line, in production code. */
function nonCommentProductionChanges(diff: string): string[] {
  const offending: string[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) file = line.slice(line.lastIndexOf(" b/") + 3);
    else if (/^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line) && isProductionCode(file)) {
      const code = line.slice(1).trim();
      if (code !== "" && !/^(\/\/|\/\*|\*)/.test(code)) offending.push(`${file}: ${line}`);
    }
  }
  return offending;
}

describe("nonCommentProductionChanges", () => {
  const diffOf = (file: string, ...lines: string[]) =>
    [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -1 +1 @@",
      ...lines,
    ].join("\n");

  it("accepts a reworded comment in production code", () => {
    expect(
      nonCommentProductionChanges(
        diffOf("packages/db/src/a.ts", "-// UW-17 old", "+// new", "+ * doc"),
      ),
    ).toEqual([]);
  });

  it("flags a changed code line in production code, including config files", () => {
    expect(
      nonCommentProductionChanges(diffOf("packages/db/src/a.ts", "-const a = 1;", "+const a = 2;")),
    ).toHaveLength(2);
    expect(
      nonCommentProductionChanges(diffOf("packages/web/vite.config.ts", "+export default {};")),
    ).toHaveLength(1);
    expect(nonCommentProductionChanges(diffOf("spikes/herdr/flood.ts", "+run();"))).toHaveLength(1);
  });

  it("ignores code changes in tests and fixtures", () => {
    expect(
      nonCommentProductionChanges(diffOf("packages/db/src/a.test.ts", "+it('x', () => {});")),
    ).toEqual([]);
    expect(nonCommentProductionChanges(diffOf("packages/web/test/flow.test.tsx", "+x();"))).toEqual(
      [],
    );
  });
});

// The guards below compare against the base branch, so they need its history (CI checks out with fetch-depth: 0).
describe("the units-of-work cleanup diff", () => {
  const baseRef = ["origin/main", "main"].find((ref) => {
    try {
      git("rev-parse", "--verify", "--quiet", ref);
      return true;
    } catch {
      return false;
    }
  });
  const base = baseRef === undefined ? undefined : git("merge-base", baseRef, "HEAD").trim();

  // The guards apply to the change that deletes the backlog; once it is merged the range is empty and they stand down.
  const removesBacklog =
    base !== undefined &&
    git("diff", "--name-only", "--diff-filter=D", base, "HEAD")
      .split("\n")
      .some((file) => file.startsWith(`${archiveDir}/`));

  it("has a base branch to compare with in CI", () => {
    if (process.env.CI) expect(base, "fetch the base branch (fetch-depth: 0)").toBeDefined();
  });

  it.skipIf(!removesBacklog)("does not touch docs/decisions", () => {
    const changed = git("diff", "--name-only", base as string, "HEAD", "--", "docs/decisions");
    expect(changed.trim()).toBe("");
  });

  it.skipIf(!removesBacklog)("only changes comment lines in production code", () => {
    const diff = git("diff", "--unified=0", base as string, "HEAD");
    const offending = nonCommentProductionChanges(diff);
    expect(offending, `non-comment production lines changed:\n${offending.join("\n")}`).toEqual([]);
  });
});
