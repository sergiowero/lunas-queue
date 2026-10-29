import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProcessRunner, ShellProcessRunner } from "@lunasq/adapters";
import { afterEach, describe, expect, it } from "vitest";
import { GATE_OUTPUT_LIMIT, GitCommitVerifier, ShellTestGate } from "./ports.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gate = { taskId: "t", runId: "r", worktreePath: "/wt" };

describe("ShellTestGate", () => {
  it("pasa solo con exit 0 y corre el comando en el worktree", async () => {
    const runner = new FakeProcessRunner(() => ({ exitCode: 0, stdout: "ok" }));
    const result = await new ShellTestGate(runner).run({ ...gate, command: "pnpm test" });
    expect(result).toEqual({ passed: true, output: "ok" });
    expect(runner.calls[0]).toMatchObject({ command: "pnpm test", cwd: "/wt" });

    runner.respond(() => ({ exitCode: 1, stderr: "1 failed" }));
    expect(await new ShellTestGate(runner).run({ ...gate, command: "pnpm test" })).toEqual({
      passed: false,
      output: "1 failed",
    });
  });

  it("falla sin comando de tests o si excede el tiempo, y recorta la salida", async () => {
    const runner = new FakeProcessRunner(() => ({ timedOut: true, stdout: "x".repeat(10_000) }));
    expect((await new ShellTestGate(runner).run({ ...gate, command: null })).passed).toBe(false);
    expect(runner.calls).toHaveLength(0);
    const slow = await new ShellTestGate(runner, { timeoutMs: 5 }).run({ ...gate, command: "t" });
    expect(slow.passed).toBe(false);
    expect(slow.output).toMatch(/tiempo límite/);
    expect(runner.calls[0]?.timeoutMs).toBe(5);
    expect(slow.output.length).toBeLessThan(GATE_OUTPUT_LIMIT + 100);
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
});
