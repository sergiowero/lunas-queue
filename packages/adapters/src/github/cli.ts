// Cliente del CLI `gh`. Corre con execFile y los argumentos sueltos, sin shell: el título y el
// cuerpo del PR vienen de agentes y no deben poder inyectar comandos. El cuerpo entra por stdin.
import { execFile } from "node:child_process";
import { GitHubError } from "./errors.ts";

export interface GhExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GhExecOptions {
  cwd?: string;
  /** Se escribe en stdin y se cierra. */
  input?: string;
  timeoutMs: number;
}

export type GhExecFn = (file: string, args: string[], opts: GhExecOptions) => Promise<GhExecResult>;

/** Límite por defecto de un comando: GitHub lento no debe colgar al poller ni a la entrega. */
export const DEFAULT_GH_TIMEOUT_MS = 60_000;

export const execGh: GhExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        // Sin prompts interactivos: un gh que pregunta se quedaría esperando hasta el timeout.
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
      },
      (err, stdout, stderr) => {
        if (err?.killed) {
          reject(
            new GitHubError("timeout", `${args.join(" ")}: sin respuesta en ${opts.timeoutMs} ms`),
          );
          return;
        }
        if (err && typeof err.code !== "number") {
          reject(new GitHubError("gh_unavailable", `${file}: ${err.message}`, { cause: err }));
          return;
        }
        resolve({ stdout, stderr, exitCode: typeof err?.code === "number" ? err.code : 0 });
      },
    );
    child.stdin?.on("error", () => {
      // gh puede salir sin leer stdin; el resultado llega por el callback.
    });
    child.stdin?.end(opts.input ?? "");
  });

export interface GhCliOptions {
  /** Ruta del binario (por defecto `gh` en el PATH). */
  bin?: string;
  exec?: GhExecFn;
  timeoutMs?: number;
}

// Mensajes de gh cuando el PR o el repo no existen (gh 2.100).
const NOT_FOUND = [/Could not resolve to a/i, /no pull requests found/i, /HTTP 404/i];

export class GhCli {
  private readonly bin: string;
  private readonly exec: GhExecFn;
  private readonly timeoutMs: number;

  constructor(opts: GhCliOptions = {}) {
    this.bin = opts.bin ?? "gh";
    this.exec = opts.exec ?? execGh;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  }

  /** Corre el comando y devuelve stdout; un exit distinto de 0 es GitHubError. */
  async text(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
    const { stdout, stderr, exitCode } = await this.exec(this.bin, args, {
      ...opts,
      timeoutMs: this.timeoutMs,
    });
    if (exitCode !== 0) throw toError(args, stderr, exitCode);
    return stdout;
  }

  /** Corre un comando con `--json` y devuelve la salida parseada. */
  async json(args: string[], opts: { cwd?: string } = {}): Promise<unknown> {
    const stdout = await this.text(args, opts);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new GitHubError("invalid_output", `${args.join(" ")}: salida no JSON: ${stdout}`);
    }
  }
}

function toError(args: string[], stderr: string, exitCode: number): GitHubError {
  const line = stderr.trim();
  const where = `${args.slice(0, 2).join(" ")} (exit ${exitCode}): ${line}`;
  if (exitCode === 4) return new GitHubError("not_authenticated", where);
  if (NOT_FOUND.some((re) => re.test(line))) return new GitHubError("not_found", where);
  return new GitHubError("gh_failed", where);
}
