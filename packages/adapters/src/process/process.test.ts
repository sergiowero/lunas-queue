import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeProcessRunner } from "./fake.ts";
import {
  findWindowsShell,
  isProcessError,
  OUTPUT_LIMIT_BYTES,
  ShellProcessRunner,
} from "./real.ts";
import type { ProcessRunner } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-proc-")));
  dirs.push(dir);
  return dir;
}

describe("ShellProcessRunner", () => {
  const runner: ProcessRunner = new ShellProcessRunner();

  it("runs the command with sh in the cwd and with the given env", async () => {
    const cwd = tempDir();
    const res = await runner.run({
      command: 'pwd; echo "$LUNASQ_X"; echo err >&2',
      cwd,
      env: { LUNASQ_X: "hola" },
    });
    expect(res).toEqual({
      exitCode: 0,
      stdout: `${cwd}\nhola\n`,
      stderr: "err\n",
      timedOut: false,
    });
  });

  it("inherits the process env", async () => {
    const res = await runner.run({ command: 'echo "$HOME"', cwd: tempDir() });
    expect(res.stdout.trim()).toBe(process.env.HOME);
  });

  it("with envAllowlist only those variables and those of env pass", async () => {
    process.env.LUNASQ_TEST_SECRET = "no-debe-verse";
    try {
      const res = await runner.run({
        command: 'printenv LUNASQ_TEST_SECRET; printf "%s|%s" "$HOME" "$LUNASQ_X"',
        cwd: tempDir(),
        env: { LUNASQ_X: "x" },
        envAllowlist: ["HOME", "LUNASQ_NO_EXISTE"],
      });
      expect(res.stdout).toBe(`${process.env.HOME}|x`);
      const unset = await runner.run({
        command: "printenv LUNASQ_NO_EXISTE || printf no-definida",
        cwd: tempDir(),
        envAllowlist: ["LUNASQ_NO_EXISTE"],
      });
      expect(unset.stdout).toBe("no-definida");
    } finally {
      delete process.env.LUNASQ_TEST_SECRET;
    }
  });

  it("returns the exit code without throwing", async () => {
    const res = await runner.run({ command: "echo uno; exit 3", cwd: tempDir() });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("uno\n");
  });

  it("kills the process group on timeout", async () => {
    const started = Date.now();
    const res = await runner.run({
      command: "sleep 5 & sleep 5; wait",
      cwd: tempDir(),
      timeoutMs: 200,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("does not hang if the command leaves a background process with the pipes open", async () => {
    const started = Date.now();
    const res = await runner.run({ command: "echo listo; sleep 30 &", cwd: tempDir() });
    expect(res).toMatchObject({ exitCode: 0, stdout: "listo\n", timedOut: false });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("keeps only the end of a huge output", async () => {
    const res = await runner.run({
      command: `head -c ${OUTPUT_LIMIT_BYTES * 2} /dev/zero | tr '\\0' a; echo FIN`,
      cwd: tempDir(),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.length).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
    expect(res.stdout.endsWith("aFIN\n")).toBe(true);
  });

  it("throws spawn_failed if the cwd does not exist", async () => {
    const err = await runner
      .run({ command: "true", cwd: join(tempDir(), "no-existe") })
      .catch((e) => e);
    expect(isProcessError(err, "spawn_failed")).toBe(true);
  });
});

describe("findWindowsShell", () => {
  const execPath = "C:/Program Files/Git/mingw64/libexec/git-core";
  const only = (path: string) => (candidate: string) => candidate === path;

  it("finds Git for Windows' sh.exe from git's exec path", () => {
    const sh = "C:\\Program Files\\Git\\bin\\sh.exe";
    expect(findWindowsShell(execPath, only(sh))).toBe(sh);
  });

  it("finds the usr/bin one when the installation has no bin/sh.exe", () => {
    const sh = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
    expect(findWindowsShell(execPath, only(sh))).toBe(sh);
  });

  it("returns undefined if there is none up to the root", () => {
    expect(findWindowsShell(execPath, () => false)).toBeUndefined();
  });
});

describe("FakeProcessRunner", () => {
  it("records the calls and answers with success by default", async () => {
    const fake = new FakeProcessRunner();
    const res = await fake.run({ command: "pnpm install", cwd: "/wt", env: { A: "1" } });
    expect(res).toEqual({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    expect(fake.calls).toEqual([{ command: "pnpm install", cwd: "/wt", env: { A: "1" } }]);
  });

  it("answers with the configured handler", async () => {
    const fake = new FakeProcessRunner(({ command }) =>
      command === "falla" ? { exitCode: 1, stderr: "boom" } : {},
    );
    expect(await fake.run({ command: "falla", cwd: "/wt" })).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      timedOut: false,
    });
    expect((await fake.run({ command: "ok", cwd: "/wt" })).exitCode).toBe(0);
  });
});
