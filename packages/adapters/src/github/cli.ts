// Client of the `gh` CLI. It runs with execFile and the arguments passed separately, without a shell: the PR
// title and body come from agents and must not be able to inject commands. The body goes in through stdin.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { GitHubError } from "./errors.ts";

export interface GhExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GhExecOptions {
  cwd?: string;
  /** Written to stdin and closed. */
  input?: string;
  timeoutMs: number;
}

export type GhExecFn = (file: string, args: string[], opts: GhExecOptions) => Promise<GhExecResult>;

/** Default limit of a command: a slow GitHub must not hang the poller or the delivery. */
export const DEFAULT_GH_TIMEOUT_MS = 60_000;

export const execGh: GhExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        // No interactive prompts: a gh that asks would hang until the timeout.
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
      },
      (err, stdout, stderr) => {
        const where = args.slice(0, 2).join(" ");
        // Node also kills the child (killed) when the output exceeds maxBuffer.
        if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new GitHubError("gh_failed", `${where}: output too large`, { cause: err }));
          return;
        }
        if (err?.killed) {
          reject(new GitHubError("timeout", `${where}: no response in ${opts.timeoutMs} ms`));
          return;
        }
        // ENOENT from the spawn: the binary or the cwd is missing (a deleted worktree).
        if (err?.code === "ENOENT") {
          const cwdMissing = opts.cwd !== undefined && !existsSync(opts.cwd);
          reject(
            cwdMissing
              ? new GitHubError("gh_failed", `${where}: ${opts.cwd} does not exist`, { cause: err })
              : new GitHubError("gh_unavailable", `${file}: ${err.message}`, { cause: err }),
          );
          return;
        }
        if (err && typeof err.code !== "number") {
          // Killed by an external signal or another process failure.
          reject(new GitHubError("gh_failed", `${where}: ${err.message}`, { cause: err }));
          return;
        }
        resolve({ stdout, stderr, exitCode: typeof err?.code === "number" ? err.code : 0 });
      },
    );
    child.stdin?.on("error", () => {
      // gh may exit without reading stdin; the result arrives through the callback.
    });
    child.stdin?.end(opts.input ?? "");
  });

export interface GhCliOptions {
  /** Binary path (by default `gh` on the PATH). */
  bin?: string;
  exec?: GhExecFn;
  timeoutMs?: number;
}

// gh messages when the PR or the repo do not exist (gh 2.100).
const NOT_FOUND = [/Could not resolve to a/i, /no pull requests found/i, /HTTP 404/i];
// Without a session gh exits with 4; an expired or revoked token exits with 1 and a 401.
const NOT_AUTHENTICATED = [/HTTP 401/i, /Bad credentials/i, /gh auth login/i];

export class GhCli {
  private readonly bin: string;
  private readonly exec: GhExecFn;
  private readonly timeoutMs: number;

  constructor(opts: GhCliOptions = {}) {
    this.bin = opts.bin ?? "gh";
    this.exec = opts.exec ?? execGh;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  }

  /** Runs the command and returns stdout; an exit other than 0 is a GitHubError. */
  async text(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
    const { stdout, stderr, exitCode } = await this.exec(this.bin, args, {
      ...opts,
      timeoutMs: this.timeoutMs,
    });
    if (exitCode !== 0) throw toError(args, stderr, exitCode);
    return stdout;
  }

  /** Runs a command with `--json` and returns the parsed output. */
  async json(args: string[], opts: { cwd?: string } = {}): Promise<unknown> {
    const stdout = await this.text(args, opts);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new GitHubError("invalid_output", `${args.join(" ")}: output is not JSON: ${stdout}`);
    }
  }
}

function toError(args: string[], stderr: string, exitCode: number): GitHubError {
  const line = stderr.trim();
  const where = `${args.slice(0, 2).join(" ")} (exit ${exitCode}): ${line}`;
  if (exitCode === 4 || NOT_AUTHENTICATED.some((re) => re.test(line))) {
    return new GitHubError("not_authenticated", where);
  }
  if (NOT_FOUND.some((re) => re.test(line))) return new GitHubError("not_found", where);
  return new GitHubError("gh_failed", where);
}
