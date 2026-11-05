// Real runner: `sh -c` in its own process group, so the timeout also kills the children. Windows has
// neither /bin/sh nor process groups: it uses Git for Windows' sh.exe and kills the process tree
// (ADR windows-shell).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { win32 } from "node:path";
import type { ProcessInput, ProcessResult, ProcessRunner } from "./types.ts";

const IS_WINDOWS = process.platform === "win32";

/** After the shell exits, how long to wait for the children to release stdout/stderr before killing them. */
export const EXIT_GRACE_MS = 200;

/** Cap per stream: from a longer output the end is kept, which is where the error is. */
export const OUTPUT_LIMIT_BYTES = 256 * 1024;

export type ProcessErrorCode = "spawn_failed";

export class ProcessError extends Error {
  readonly code: ProcessErrorCode;

  constructor(code: ProcessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProcessError";
    this.code = code;
  }
}

export function isProcessError(err: unknown, code?: ProcessErrorCode): err is ProcessError {
  return err instanceof ProcessError && (code === undefined || err.code === code);
}

/** Accumulates a stream and keeps its last `limit` bytes. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;

  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size - (this.chunks[0]?.length ?? 0) >= this.limit) {
      this.size -= this.chunks.shift()?.length ?? 0;
    }
  }

  toString() {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - this.limit)).toString("utf8");
  }
}

/**
 * Git for Windows' sh.exe, looking upwards from `git --exec-path`. `sh` and `bash` from the PATH are
 * not used: the first is usually not there and the second may be the WSL launcher, which would run
 * the command inside a Linux distribution.
 */
export function findWindowsShell(
  gitExecPath: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  for (let dir = gitExecPath; ; dir = win32.dirname(dir)) {
    const found = [win32.join(dir, "bin", "sh.exe"), win32.join(dir, "usr", "bin", "sh.exe")].find(
      exists,
    );
    if (found) return found;
    if (win32.dirname(dir) === dir) return undefined;
  }
}

function gitExecPath(): string | undefined {
  try {
    return execFileSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return undefined;
  }
}

let windowsShell: string | undefined;

function shell(): string {
  if (!IS_WINDOWS) return "/bin/sh";
  if (windowsShell) return windowsShell;
  const execPath = gitExecPath();
  windowsShell = execPath === undefined ? undefined : findWindowsShell(execPath);
  if (!windowsShell) {
    throw new ProcessError(
      "spawn_failed",
      "sh.exe not found: install Git for Windows and make sure `git` is on the PATH",
    );
  }
  return windowsShell;
}

export class ShellProcessRunner implements ProcessRunner {
  run(input: ProcessInput): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(shell(), ["-c", input.command], {
        cwd: input.cwd,
        env: { ...inheritedEnv(input.envAllowlist), ...input.env },
        stdio: ["ignore", "pipe", "pipe"],
        // On Windows `detached` means a new console, not a process group.
        detached: !IS_WINDOWS,
        windowsHide: true,
      });
      const stdout = new Tail(OUTPUT_LIMIT_BYTES);
      const stderr = new Tail(OUTPUT_LIMIT_BYTES);
      child.stdout.on("data", (c: Buffer) => stdout.push(c));
      child.stderr.on("data", (c: Buffer) => stderr.push(c));

      let timedOut = false;
      const timer =
        input.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              killGroup(child);
            }, input.timeoutMs);

      let grace: NodeJS.Timeout | undefined;
      let done = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(grace);
        resolve({
          exitCode: code ?? (signal ? 128 + constants.signals[signal] : 1),
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          timedOut,
        });
      };

      child.on("error", (err) => {
        done = true;
        clearTimeout(timer);
        reject(
          new ProcessError("spawn_failed", `${input.command}: ${err.message}`, { cause: err }),
        );
      });
      // `close` waits for everything that has the pipes open: a background child (daemon,
      // watcher) would hang it. When the shell exits it is given a margin and then whatever is left
      // of its group is killed; a child that went to another session (setsid) loses the pipes, it does not hang.
      child.on("exit", (code, signal) => {
        grace = setTimeout(() => {
          killGroup(child);
          child.stdout.destroy();
          child.stderr.destroy();
          finish(code, signal);
        }, EXIT_GRACE_MS);
      });
      child.on("close", (code, signal) => {
        killGroup(child);
        finish(code, signal);
      });
    });
  }
}

/** The process env, or only the allowlist variables if there is one. */
function inheritedEnv(allowlist: string[] | undefined): NodeJS.ProcessEnv {
  if (allowlist === undefined) return process.env;
  return Object.fromEntries(
    allowlist.filter((name) => process.env[name] !== undefined).map((n) => [n, process.env[n]]),
  );
}

function killGroup(child: ChildProcess) {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    // `taskkill /T` walks down from the shell, so it can only find the children while the shell lives.
    if (child.exitCode !== null || child.signalCode !== null) return;
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group already finished.
  }
}
