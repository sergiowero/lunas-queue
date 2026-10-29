// Adapter real de git: execFile con los argumentos sueltos, sin shell. Rutas y mensajes pueden
// venir de la configuración del proyecto y no deben poder inyectar comandos.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { GitError } from "./errors.ts";
import type { GitAdapter, GitFile } from "./types.ts";

/** Límite de un comando local; el fetch, que va a la red, tiene el suyo. */
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 5 * 60_000;

export interface RealGitOptions {
  /** Ruta del binario (por defecto `git` en el PATH). */
  bin?: string;
  timeoutMs?: number;
  fetchTimeoutMs?: number;
}

interface GitRun {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

const REGULAR_FILE = "100644";
const EXECUTABLE_FILE = "100755";

export class RealGit implements GitAdapter {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly fetchTimeoutMs: number;

  constructor(opts: RealGitOptions = {}) {
    this.bin = opts.bin ?? "git";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async fetch(input: { cwd: string; remote: string; branch: string }) {
    const refspec = `+refs/heads/${input.branch}:refs/remotes/${input.remote}/${input.branch}`;
    await this.ok(input.cwd, ["fetch", "--quiet", "--no-tags", input.remote, refspec], {
      timeoutMs: this.fetchTimeoutMs,
    });
  }

  async resolveCommit(input: { cwd: string; ref: string }) {
    const res = await this.run(input.cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${input.ref}^{commit}`,
    ]);
    if (res.exitCode !== 0) throw new GitError("ref_not_found", `${input.ref} en ${input.cwd}`);
    return res.stdout.toString("utf8").trim();
  }

  async listFiles(input: { cwd: string; commit: string; dir: string }): Promise<GitFile[]> {
    const dir = input.dir.replace(/\/+$/, "");
    const entries = await this.lsTree(input.cwd, input.commit, `${dir}/`);
    return entries
      .filter((e) => e.mode === REGULAR_FILE || e.mode === EXECUTABLE_FILE)
      .map((e) => ({ name: e.path.slice(dir.length + 1), executable: e.mode === EXECUTABLE_FILE }));
  }

  async readFile(input: { cwd: string; commit: string; path: string }) {
    // ls-tree distingue "no existe" de un fallo real, que cat-file mezcla en el mismo exit 128.
    const [entry] = await this.lsTree(input.cwd, input.commit, input.path);
    if (!entry || (entry.mode !== REGULAR_FILE && entry.mode !== EXECUTABLE_FILE)) return undefined;
    const res = await this.ok(input.cwd, ["cat-file", "blob", entry.object]);
    return res.stdout;
  }

  async isDirty(cwd: string) {
    const res = await this.ok(cwd, ["status", "--porcelain", "--untracked-files=all", "-z"]);
    return res.stdout.length > 0;
  }

  async commitAll(input: { cwd: string; message: string; trailers: Record<string, string> }) {
    if (!(await this.isDirty(input.cwd))) return null;
    await this.ok(input.cwd, ["add", "--all"]);
    // Los trailers van en su propio párrafo. Con `--trailer`, git toma como bloque de trailers un
    // asunto de una línea con `: ` (`chore(lunasq): …`) y los pega sin línea en blanco.
    const trailers = Object.entries(input.trailers).map(([k, v]) => `${k}: ${v}`);
    const paragraphs = trailers.length ? ["--message", trailers.join("\n")] : [];
    await this.ok(input.cwd, ["commit", "--quiet", "--message", input.message, ...paragraphs]);
    return this.resolveCommit({ cwd: input.cwd, ref: "HEAD" });
  }

  private async lsTree(cwd: string, commit: string, path: string) {
    const res = await this.ok(cwd, ["ls-tree", "-z", "--full-tree", commit, "--", path]);
    return res.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        // <modo> SP <tipo> SP <objeto> TAB <ruta>
        const tab = line.indexOf("\t");
        const [mode = "", , object = ""] = line.slice(0, tab).split(" ");
        return { mode, object, path: line.slice(tab + 1) };
      });
  }

  private async ok(cwd: string, args: string[], opts: { timeoutMs?: number } = {}) {
    const res = await this.run(cwd, args, opts);
    if (res.exitCode !== 0) {
      throw new GitError(
        "git_failed",
        `${args[0]} en ${cwd} (exit ${res.exitCode}): ${res.stderr.trim()}`,
      );
    }
    return res;
  }

  private run(cwd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<GitRun> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        args,
        {
          cwd,
          // Sin prompts de credenciales: un fetch que pregunta se quedaría esperando.
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
          encoding: "buffer",
          maxBuffer: 64 * 1024 * 1024,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
        },
        (err, stdout, stderr) => {
          const where = `${args[0]} en ${cwd}`;
          if (err?.killed) {
            reject(new GitError("timeout", `${where}: sin respuesta en ${timeoutMs} ms`));
            return;
          }
          if (err?.code === "ENOENT") {
            const what = existsSync(cwd) ? `${this.bin}: ${err.message}` : `no existe ${cwd}`;
            reject(new GitError("git_unavailable", what, { cause: err }));
            return;
          }
          if (err && typeof err.code !== "number") {
            reject(new GitError("git_failed", `${where}: ${err.message}`, { cause: err }));
            return;
          }
          resolve({
            stdout,
            stderr: stderr.toString("utf8"),
            exitCode: typeof err?.code === "number" ? err.code : 0,
          });
        },
      );
    });
  }
}
