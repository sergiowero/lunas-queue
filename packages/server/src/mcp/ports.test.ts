import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellProcessRunner } from "@lunasq/adapters";
import { afterEach, describe, expect, it } from "vitest";
import type { HookService } from "../hooks/service.ts";
import { GitCommitVerifier, type PhaseHooks, tailOf } from "./ports.ts";

// HookService is what the server composition passes as PhaseHooks: if it stops meeting the
// port, the typecheck fails here and not only in UW-29.
const _hookServiceIsPhaseHooks = (service: HookService): PhaseHooks => service;
void _hookServiceIsPhaseHooks;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tailOf", () => {
  it("keeps the end of a long text and leaves a short one intact", () => {
    expect(tailOf("abcdef", 3)).toBe("def");
    expect(tailOf("ab", 3)).toBe("ab");
  });
});

describe("GitCommitVerifier against a real repo", { timeout: 30_000 }, () => {
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

  it("accepts commits from the branch and rejects those of the base or unknown ones", async () => {
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

  it("rejects a commit already in origin/<base> even if the local base is behind", async () => {
    const { dir, base } = repo();
    // The worktree comes from origin/main (ADR 0012); the local main stayed at `base`.
    git(dir, "reset", "-q", "--hard", base);
    git(dir, "init", "-q", "--bare", join(dir, ".git", "origin.git"));
    git(dir, "remote", "add", "origin", join(dir, ".git", "origin.git"));
    writeFileSync(join(dir, "upstream.txt"), "upstream");
    git(dir, "add", "upstream.txt");
    git(dir, "commit", "-q", "-m", "upstream");
    const upstream = git(dir, "rev-parse", "HEAD");
    git(dir, "push", "-q", "origin", "HEAD:main");
    git(dir, "fetch", "-q", "origin");
    writeFileSync(join(dir, "work.txt"), "work");
    git(dir, "add", "work.txt");
    git(dir, "commit", "-q", "-m", "work");
    const work = git(dir, "rev-parse", "HEAD");
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(
      await verifier.missing({ worktreePath: dir, baseBranch: "main", commits: [work, upstream] }),
    ).toEqual([upstream]);
  });

  it("a nonexistent base branch does not vouch for the commits", async () => {
    const { dir, work } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(
      await verifier.missing({ worktreePath: dir, baseBranch: "no-existe", commits: [work] }),
    ).toEqual([work]);
  });

  it("branchHasCommits tells a branch with commits from one that is in the base", async () => {
    const { dir, base } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(await verifier.branchHasCommits({ worktreePath: dir, baseBranch: "main" })).toBe(true);
    // Without own commits: the branch points at the base.
    git(dir, "reset", "-q", "--hard", base);
    expect(await verifier.branchHasCommits({ worktreePath: dir, baseBranch: "main" })).toBe(false);
  });

  it("changedFiles lists committed changes from the merge base and returns an empty list at base", async () => {
    const { dir, base } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(await verifier.changedFiles({ worktreePath: dir, baseBranch: "main" })).toEqual([
      "work.txt",
    ]);

    git(dir, "reset", "-q", "--hard", base);
    expect(await verifier.changedFiles({ worktreePath: dir, baseBranch: "main" })).toEqual([]);
  });

  it("changedFiles returns null when neither base ref can be resolved", async () => {
    const { dir } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(await verifier.changedFiles({ worktreePath: dir, baseBranch: "--all" })).toBeNull();
  });

  it("branchHasCommits does not count what is already in origin/<base> even if the local base is behind", async () => {
    const { dir, base } = repo();
    git(dir, "reset", "-q", "--hard", base);
    git(dir, "init", "-q", "--bare", join(dir, ".git", "origin.git"));
    git(dir, "remote", "add", "origin", join(dir, ".git", "origin.git"));
    writeFileSync(join(dir, "upstream.txt"), "upstream");
    git(dir, "add", "upstream.txt");
    git(dir, "commit", "-q", "-m", "upstream");
    git(dir, "push", "-q", "origin", "HEAD:main");
    git(dir, "fetch", "-q", "origin");
    // HEAD is origin/main; the local main stayed at `base`.
    git(dir, "branch", "-f", "main", base);
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(await verifier.branchHasCommits({ worktreePath: dir, baseBranch: "main" })).toBe(false);
  });

  it("branchHasCommits with a base that does not exist assumes there are commits", async () => {
    const { dir } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(await verifier.branchHasCommits({ worktreePath: dir, baseBranch: "no-existe" })).toBe(
      true,
    );
  });

  it("uncommitted lists changes and untracked files; empty with a clean worktree", async () => {
    const { dir } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(await verifier.uncommitted(dir)).toEqual([]);
    writeFileSync(join(dir, "work.txt"), "cambio");
    writeFileSync(join(dir, "nuevo.txt"), "x");
    expect((await verifier.uncommitted(dir)).sort()).toEqual(["nuevo.txt", "work.txt"]);
  });

  it("uncommitted ignores the evidence file of lunasq/tasks/", async () => {
    const { dir } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    mkdirSync(join(dir, "lunasq/tasks"), { recursive: true });
    writeFileSync(join(dir, "lunasq/tasks/t1.md"), "# evidencia");
    expect(await verifier.uncommitted(dir)).toEqual([]);
    writeFileSync(join(dir, "work.txt"), "cambio");
    expect(await verifier.uncommitted(dir)).toEqual(["work.txt"]);
  });

  it("onlyEvidenceBetween accepts commits that only touch lunasq/tasks/", async () => {
    const { dir, work } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(await verifier.onlyEvidenceBetween({ worktreePath: dir, from: work, to: work })).toBe(
      true,
    );

    mkdirSync(join(dir, "lunasq/tasks"), { recursive: true });
    writeFileSync(join(dir, "lunasq/tasks/t1.md"), "# evidencia\n");
    git(dir, "add", "lunasq/tasks/t1.md");
    git(dir, "commit", "-q", "-m", "evidencia");
    const evidence = git(dir, "rev-parse", "HEAD");
    expect(
      await verifier.onlyEvidenceBetween({ worktreePath: dir, from: work, to: evidence }),
    ).toBe(true);

    writeFileSync(join(dir, "work.txt"), "cambio");
    git(dir, "commit", "-q", "-am", "código");
    const code = git(dir, "rev-parse", "HEAD");
    expect(await verifier.onlyEvidenceBetween({ worktreePath: dir, from: work, to: code })).toBe(
      false,
    );
  });

  it("onlyEvidenceBetween rejects a HEAD that does not descend from the gate's commit", async () => {
    const { dir, base, work } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(await verifier.onlyEvidenceBetween({ worktreePath: dir, from: work, to: base })).toBe(
      false,
    );
  });

  it("a base branch shaped like an option is not interpreted as an option", async () => {
    const { dir, work } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(
      await verifier.missing({ worktreePath: dir, baseBranch: "--all", commits: [work] }),
    ).toEqual([work]);
  });
});
