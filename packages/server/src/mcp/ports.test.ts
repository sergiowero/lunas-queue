import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellProcessRunner } from "@lunasq/adapters";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommitVerifier, tailOf } from "./ports.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tailOf", () => {
  it("conserva el final de un texto largo y deja intacto uno corto", () => {
    expect(tailOf("abcdef", 3)).toBe("def");
    expect(tailOf("ab", 3)).toBe("ab");
  });
});

describe("GitCommitVerifier contra un repo real", () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "lunasq-git-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    const commit = (file: string) => {
      writeFileSync(join(dir, file), file);
      git(dir, "add", file);
      git(dir, "commit", "-q", "-m", file);
      return git(dir, "rev-parse", "HEAD");
    };
    const base = commit("base.txt");
    git(dir, "checkout", "-q", "-b", "lunasq/tarea");
    const work = commit("work.txt");
    return { dir, base, work };
  }

  it("acepta commits del branch y rechaza los de la base o desconocidos", async () => {
    const { dir, base, work } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    const unknown = "0".repeat(40);
    expect(
      await verifier.missing({ worktreePath: dir, baseBranch: "main", commits: [work] }),
    ).toEqual([]);
    expect(
      await verifier.missing({
        worktreePath: dir,
        baseBranch: "main",
        commits: [work, base, unknown],
      }),
    ).toEqual([base, unknown]);
  });

  it("una rama base inexistente no da los commits por buenos", async () => {
    const { dir, work } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(
      await verifier.missing({ worktreePath: dir, baseBranch: "no-existe", commits: [work] }),
    ).toEqual([work]);
  });

  it("uncommitted lista cambios y archivos sin seguimiento; vacío con el worktree limpio", async () => {
    const { dir } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(await verifier.uncommitted(dir)).toEqual([]);
    writeFileSync(join(dir, "work.txt"), "cambio");
    writeFileSync(join(dir, "nuevo.txt"), "x");
    expect((await verifier.uncommitted(dir)).sort()).toEqual(["nuevo.txt", "work.txt"]);
  });

  it("una rama base con forma de opción no se interpreta como opción de git", async () => {
    const { dir, work } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(
      await verifier.missing({ worktreePath: dir, baseBranch: "--all", commits: [work] }),
    ).toEqual([work]);
  });
});
