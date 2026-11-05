// `pnpm dev`: the LunasQ server and Vite in one terminal. Vite sends /api to the port in the
// configuration; if either process ends, the other one is stopped. Everything runs on this Node
// without a shell, so it works the same on Windows, macOS and Linux.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { baseUrl, ConfigError, readConfig } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";

export interface DevProcess {
  label: string;
  /** Arguments for Node. */
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

type Write = (text: string) => void;

/** Writes each complete line with its label, so the output of two processes does not get mixed. */
function labelled(label: string, write: Write) {
  let pending = "";
  return {
    push(chunk: Buffer) {
      const lines = (pending + chunk.toString("utf8")).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) write(`[${label}] ${line}\n`);
    },
    flush() {
      if (pending) write(`[${label}] ${pending}\n`);
      pending = "";
    },
  };
}

/**
 * Runs the processes until one ends or a signal arrives, stops the rest and resolves with the exit
 * code: that of the first to end, or 0 after a signal. A second signal ends the process as usual.
 */
export function supervise(
  processes: DevProcess[],
  write: Write = (text) => process.stdout.write(text),
): Promise<number> {
  return new Promise((resolve) => {
    let result: number | undefined;
    let running = processes.length;
    const stop = (code: number) => {
      if (result !== undefined) return;
      result = code;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      for (const child of children) child.kill();
    };
    const onSignal = () => stop(0);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const children = processes.map(({ label, args, cwd, env }) => {
      const child = spawn(process.execPath, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["inherit", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout = labelled(label, write);
      const stderr = labelled(label, write);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (err) => {
        write(`[${label}] ${err.message}\n`);
      });
      child.on("close", (code) => {
        stdout.flush();
        stderr.flush();
        stop(code ?? 1);
        running -= 1;
        if (running === 0) resolve(result ?? 1);
      });
      return child;
    });
  });
}

async function main(): Promise<number> {
  const paths = resolvePaths();
  let config: Awaited<ReturnType<typeof readConfig>>;
  try {
    config = await readConfig(paths.config);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`invalid configuration in ${paths.config}: ${err.message}\n`);
    return 1;
  }
  if (!config) {
    process.stderr.write("LunasQ is not installed: run `pnpm lunasq install`.\n");
    return 1;
  }
  const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
  return supervise([
    { label: "api", args: [path("../src/bin.ts"), "start"] },
    {
      label: "web",
      args: [path("../../web/node_modules/vite/bin/vite.js")],
      cwd: path("../../web/"),
      env: { LUNASQ_API: baseUrl(config) },
    },
  ]);
}

if (import.meta.main) process.exitCode = await main();
