import { describe, expect, it } from "vitest";
import { execGh, GhCli, type GhExecFn, type GhExecOptions } from "./cli.ts";

function fakeExec(stdout: string, stderr = "", exitCode = 0) {
  const calls: { file: string; args: string[]; opts: GhExecOptions }[] = [];
  const exec: GhExecFn = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return { stdout, stderr, exitCode };
  };
  return { exec, calls };
}

describe("GhCli", () => {
  it("passes arguments, cwd, stdin and timeout as is", async () => {
    const { exec, calls } = fakeExec("https://github.com/o/r/pull/1\n");
    const cli = new GhCli({ bin: "/bin/gh", exec, timeoutMs: 1_000 });
    await cli.text(["pr", "create", "--title", "$(rm -rf /)"], { cwd: "/repo", input: "cuerpo" });
    expect(calls).toEqual([
      {
        file: "/bin/gh",
        args: ["pr", "create", "--title", "$(rm -rf /)"],
        opts: { cwd: "/repo", input: "cuerpo", timeoutMs: 1_000 },
      },
    ]);
  });

  it("parses JSON output and rejects what is not", async () => {
    expect(await new GhCli({ exec: fakeExec('{"a":1}').exec }).json(["pr", "view"])).toEqual({
      a: 1,
    });
    await expect(
      new GhCli({ exec: fakeExec("hola").exec }).json(["pr", "view"]),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });

  it.each([
    [4, "To get started with GitHub CLI, please run:  gh auth login", "not_authenticated"],
    [1, "GraphQL: Could not resolve to a PullRequest with the number of 999.", "not_found"],
    [1, 'no pull requests found for branch "x"', "not_found"],
    [1, "HTTP 401: Bad credentials (https://api.github.com/graphql)", "not_authenticated"],
    [1, "HTTP 502: Bad Gateway", "gh_failed"],
  ])("exit %i with «%s» is %s", async (exitCode, stderr, code) => {
    const { exec } = fakeExec("", stderr, exitCode);
    await expect(new GhCli({ exec }).text(["pr", "view", "1"])).rejects.toMatchObject({ code });
  });

  it("execGh writes stdin, respects cwd and reports the exit code", async () => {
    const res = await execGh("/bin/sh", ["-c", "cat; pwd; echo err >&2; exit 3"], {
      cwd: "/",
      input: "hola\n",
      timeoutMs: 5_000,
    });
    expect(res).toEqual({ stdout: "hola\n/\n", stderr: "err\n", exitCode: 3 });
  });

  it("execGh kills the process that does not respond and reports a missing binary", async () => {
    await expect(execGh("sleep", ["5"], { timeoutMs: 100 })).rejects.toMatchObject({
      code: "timeout",
    });
    await expect(execGh("/no/existe/gh", [], { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "gh_unavailable",
    });
  });

  it("execGh tells apart a deleted cwd, a huge output and an external signal", async () => {
    await expect(
      execGh("/bin/sh", ["-c", "true"], { cwd: "/no/existe/worktree", timeoutMs: 1_000 }),
    ).rejects.toMatchObject({
      code: "gh_failed",
      message: expect.stringContaining("does not exist"),
    });
    await expect(
      execGh("/bin/sh", ["-c", "head -c 70000000 /dev/zero"], { timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ code: "gh_failed", message: expect.stringContaining("too large") });
    await expect(
      execGh("/bin/sh", ["-c", "kill -TERM $$"], { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "gh_failed" });
  });
});
