import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellProcessRunner } from "@lunasq/adapters";
import { afterEach, describe, expect, it } from "vitest";
import type { HookService } from "../hooks/service.ts";
import { GitCommitVerifier, type PhaseHooks, tailOf } from "./ports.ts";

// HookService es lo que la composición del servidor pasa como PhaseHooks: si deja de cumplir el
// puerto, el typecheck falla aquí y no recién en UW-29.
const _hookServiceIsPhaseHooks = (service: HookService): PhaseHooks => service;
void _hookServiceIsPhaseHooks;

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

describe("GitCommitVerifier contra un repo real", { timeout: 30_000 }, () => {
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

  it("rechaza un commit que ya está en origin/<base> aunque la base local vaya atrasada", async () => {
    const { dir, base } = repo();
    // El worktree sale de origin/main (ADR 0012); la main local se quedó en `base`.
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

  it("uncommitted ignora el archivo de evidencia de lunasq/tasks/", async () => {
    const { dir } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    mkdirSync(join(dir, "lunasq/tasks"), { recursive: true });
    writeFileSync(join(dir, "lunasq/tasks/t1.md"), "# evidencia");
    expect(await verifier.uncommitted(dir)).toEqual([]);
    writeFileSync(join(dir, "work.txt"), "cambio");
    expect(await verifier.uncommitted(dir)).toEqual(["work.txt"]);
  });

  it("onlyEvidenceBetween acepta commits que solo tocan lunasq/tasks/", async () => {
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

  it("onlyEvidenceBetween rechaza un HEAD que no desciende del commit del gate", async () => {
    const { dir, base, work } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(await verifier.onlyEvidenceBetween({ worktreePath: dir, from: work, to: base })).toBe(
      false,
    );
  });

  it("una rama base con forma de opción no se interpreta como opción de git", async () => {
    const { dir, work } = repo();
    const verifier = new GitCommitVerifier(new ShellProcessRunner());
    expect(
      await verifier.missing({ worktreePath: dir, baseBranch: "--all", commits: [work] }),
    ).toEqual([work]);
  });
});
