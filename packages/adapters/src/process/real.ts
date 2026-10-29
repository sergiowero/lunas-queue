// Runner real: `sh -c` en su propio grupo de procesos, para que el timeout mate también a los hijos.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { ProcessInput, ProcessResult, ProcessRunner } from "./types.ts";

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

  constructor(private readonly limit: number) {}

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

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new ProcessError("spawn_failed", `${input.command}: ${err.message}`, { cause: err }),
        );
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? (signal ? 128 + constants.signals[signal] : 1),
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          timedOut,
        });
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
