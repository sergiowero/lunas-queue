// Runner real: `sh -c` en su propio grupo de procesos, para que el timeout mate también a los hijos.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { ProcessInput, ProcessResult, ProcessRunner } from "./types.ts";

/** Tras salir el shell, cuánto se espera a que los hijos suelten stdout/stderr antes de matarlos. */
export const EXIT_GRACE_MS = 200;

/** Tope por stream: de una salida más larga se conserva el final, que es donde está el error. */
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

/** Acumula un stream y conserva sus últimos `limit` bytes. */
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

export class ShellProcessRunner implements ProcessRunner {
  run(input: ProcessInput): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", input.command], {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
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
              killGroup(child.pid);
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
      // `close` espera a todo el que tenga los pipes abiertos: un hijo en background (daemon,
      // watcher) lo colgaría. Al salir el shell se le da un margen y luego se mata lo que quede
      // de su grupo; un hijo que se fue a otra sesión (setsid) pierde los pipes, no cuelga.
      child.on("exit", (code, signal) => {
        grace = setTimeout(() => {
          killGroup(child.pid);
          child.stdout.destroy();
          child.stderr.destroy();
          finish(code, signal);
        }, EXIT_GRACE_MS);
      });
      child.on("close", (code, signal) => {
        killGroup(child.pid);
        finish(code, signal);
      });
    });
  }
}

function killGroup(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // El grupo ya terminó.
  }
}
