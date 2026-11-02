// Client of the herdr CLI. Each operation is a `herdr --session S <group> <sub> ...` process
// with JSON output `{"id","result"}` on stdout. Server errors: empty stdout,
// `{"error":{"code","message"}}` on stderr and exit 1; syntax errors: exit 2 (ADR 0004).
import { execFile } from "node:child_process";
import { HerdrError } from "./errors.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** `timeoutMs` 0 = no limit. */
export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

/** Default limit of a command: a hung herdr must not hang the dispatcher. */
export const DEFAULT_CLI_TIMEOUT_MS = 30_000;

export const execHerdr: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const opts = {
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL" as const,
    };
    execFile(file, args, opts, (err, stdout, stderr) => {
      if (err?.killed) {
        reject(new HerdrError("cli_timeout", `${args.join(" ")}: no response in ${timeoutMs} ms`));
        return;
      }
      if (err && typeof err.code !== "number") {
        reject(new HerdrError("cli_unavailable", `${file}: ${err.message}`));
        return;
      }
      resolve({ stdout, stderr, exitCode: typeof err?.code === "number" ? err.code : 0 });
    });
  });

export interface HerdrCliOptions {
  /** Path of the herdr binary (by default `herdr` on the PATH). */
  bin?: string;
  /** herdr session; if omitted it uses the user's default session. */
  session?: string;
  exec?: ExecFn;
}

export class HerdrCli {
  private readonly bin: string;
  private readonly session: string | undefined;
  private readonly exec: ExecFn;

  constructor(opts: HerdrCliOptions = {}) {
    this.bin = opts.bin ?? "herdr";
    this.session = opts.session;
    this.exec = opts.exec ?? execHerdr;
  }

  /** Runs the command and returns `result` of the JSON response. */
  async json(args: string[], opts: { timeoutMs?: number } = {}): Promise<unknown> {
    const stdout = await this.text(args, opts);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new HerdrError("invalid_response", `${args.join(" ")}: output is not JSON: ${stdout}`);
    }
    if (typeof parsed !== "object" || parsed === null || !("result" in parsed)) {
      throw new HerdrError("invalid_response", `${args.join(" ")}: sin result: ${stdout}`);
    }
    return parsed.result;
  }

  /** Runs the command and returns stdout as is (e.g. `agent read`, `report-metadata`). */
  async text(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
    const full = this.session ? ["--session", this.session, ...args] : args;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    const { stdout, stderr, exitCode } = await this.exec(this.bin, full, timeoutMs);
    if (exitCode !== 0) throw toError(args, stderr, exitCode);
    return stdout;
  }
}

function toError(args: string[], stderr: string, exitCode: number): HerdrError {
  const line = stderr.trim();
  try {
    const parsed = JSON.parse(line) as { error?: { code?: unknown; message?: unknown } };
    if (typeof parsed.error?.code === "string") {
      return new HerdrError(parsed.error.code, String(parsed.error.message ?? ""));
    }
  } catch {
    // stderr is not JSON: a CLI syntax error or another process failure.
  }
  const code = exitCode === 2 ? "cli_usage" : "cli_failed";
  return new HerdrError(code, `${args.join(" ")} (exit ${exitCode}): ${line}`);
}
