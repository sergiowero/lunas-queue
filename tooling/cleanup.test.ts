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

  it("docs/archive no longer exists and docs/decisions keeps its ADRs", () => {
    expect(existsSync(join(root, archiveDir))).toBe(false);
    const decisions = readdirSync(join(root, "docs", "decisions"));
    expect(decisions.length).toBeGreaterThan(0);
    // The ADRs born during the initial development keep their file names.
    const unitAdrs = decisions.filter((name) => /^uw-\d+-.+\.md$/.test(name));
    expect(unitAdrs.length).toBe(18);
    expect(decisions).toContain("uw-10-hooks.md");
    expect(decisions).toContain("uw-29-e2e.md");
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

describe("the units-of-work cleanup commit", () => {
  const baseRef = ["origin/main", "main"].find((ref) => {
    try {
      git("rev-parse", "--verify", "--quiet", ref);
      return true;
    } catch {
      return false;
    }
  });

  function cleanupCommits(): string[] {
    if (baseRef === undefined) return [];
    try {
      const base = git("merge-base", baseRef, "HEAD").trim();
      return git("log", "--format=%H%x09%s", `${base}..HEAD`)
        .split("\n")
        .filter((line) => /remove obsolete units-of-work backlog/i.test(line))
        .map((line) => line.split("\t")[0] as string);
    } catch {
      return [];
    }
  }

  const commits = cleanupCommits();
  // Only meaningful while the commit is ahead of the base branch; once merged there is nothing to compare.
  const present = commits.length > 0;

  const isProductionCode = (file: string) =>
    /^packages\/[^/]+\/src\/.+\.tsx?$/.test(file) &&
    !/\.(test|spec)\.tsx?$/.test(file) &&
    !/\/(test|tests|fixtures)\//.test(file);

  it.skipIf(!present)("does not touch docs/decisions", () => {
    const changed = commits.flatMap((sha) =>
      git("show", "--format=", "--name-only", "-M", sha)
        .split("\n")
        .filter((file) => file.startsWith("docs/decisions/")),
    );
    expect(changed).toEqual([]);
  });

  it.skipIf(!present)("only changes comment lines in production code", () => {
    const offending = commits.flatMap((sha) => {
      const diff = git("show", "--format=", "--unified=0", sha, "--", "packages");
      let file = "";
      const lines: string[] = [];
      for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) file = line.slice(line.lastIndexOf(" b/") + 3);
        else if (/^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line) && isProductionCode(file)) {
          const code = line.slice(1).trim();
          if (code !== "" && !/^(\/\/|\/\*|\*)/.test(code)) lines.push(`${file}: ${line}`);
        }
      }
      return lines;
    });
    expect(offending, `non-comment production lines changed:\n${offending.join("\n")}`).toEqual([]);
  });
});
