// `lunasq` binary: `install`, `doctor` and `start` (docs/tech-stack.md, CLI and installer).
import { parseArgs } from "node:util";
import { type Runtime, type RuntimeOptions, startRuntime } from "@lunasq/server";
import pkg from "../package.json" with { type: "json" };
import { ConfigError, isPort, readConfig } from "./config.ts";
import { type MachineContext, machineContext } from "./context.ts";
import { formatResults, isGreen, runDoctor } from "./doctor.ts";
import { install } from "./install.ts";

export const VERSION: string = pkg.version;

export const USAGE = `lunasq ${VERSION}

Usage:
  lunasq install [--port <n>]   verifies herdr, Claude Code and gh and installs what LunasQ needs
  lunasq doctor [--json]        checks that the machine is ready
  lunasq start                  starts LunasQ on localhost
  lunasq --version
`;

export interface MainDeps {
  context?: () => MachineContext;
  out?: (text: string) => void;
  err?: (text: string) => void;
  startRuntime?: (opts: RuntimeOptions) => Promise<Runtime>;
  /** Resolves when the process must end (SIGINT or SIGTERM). */
  untilSignal?: () => Promise<void>;
}

export function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    // When the first signal arrives the two listeners are removed: if `stop()` hangs, the second
    // signal (SIGINT or SIGTERM) ends the process as usual.
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

/** Returns the exit code. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const out = deps.out ?? ((t: string) => process.stdout.write(`${t}\n`));
  const err = deps.err ?? ((t: string) => process.stderr.write(`${t}\n`));
  const context = deps.context ?? machineContext;

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { command, values } = parsed;

  if (values.version) {
    out(VERSION);
    return 0;
  }
  if (values.help || command === undefined || command === "help") {
    out(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case "doctor": {
        const results = await runDoctor(context());
        out(values.json ? JSON.stringify(results, null, 2) : formatResults(results));
        return isGreen(results) ? 0 : 1;
      }
      case "install": {
        let port: number | undefined;
        if (values.port !== undefined) {
          port = Number(values.port);
          if (!isPort(port)) {
            err(`invalid --port: ${values.port}`);
            return 2;
          }
        }
        const result = await install(context(), port === undefined ? {} : { port });
        if (result.stage === "prerequisites") {
          err(`Missing requirements; nothing was installed.\n${formatResults(result.checks)}`);
          return 1;
        }
        out(
          result.changes.length > 0
            ? `Instalado:\n${result.changes.map((c) => `  · ${c}`).join("\n")}`
            : "Everything was already up to date.",
        );
        out(`\n${formatResults(result.checks)}`);
        return result.ok ? 0 : 1;
      }
      case "start":
        return await start(context(), deps, out, err);
      default:
        err(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    err(`lunasq ${command}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function start(
  ctx: MachineContext,
  deps: MainDeps,
  out: (t: string) => void,
  err: (t: string) => void,
): Promise<number> {
  let config: Awaited<ReturnType<typeof readConfig>>;
  try {
    config = await readConfig(ctx.paths.config);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    err(`invalid configuration in ${ctx.paths.config}: ${e.message}`);
    return 1;
  }
  if (!config) {
    err("LunasQ is not installed: run `lunasq install`.");
    return 1;
  }
  const runtime = await (deps.startRuntime ?? startRuntime)({
    dbPath: ctx.paths.db,
    port: config.port,
    mcpConfigPath: ctx.paths.mcpConfig,
    hookSettingsPath: ctx.paths.hookSettings,
    copilotAgentsPath: ctx.paths.copilotAgents,
    telemetry: config.telemetry,
    ...(ctx.webRoot && { webRoot: ctx.webRoot }),
    log: err,
  });
  out(`LunasQ en ${runtime.url}`);
  await (deps.untilSignal ?? untilSignal)();
  await runtime.stop();
  return 0;
}

function parse(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (positionals.length > 1) throw new Error(`extra arguments: ${positionals.slice(1).join(" ")}`);
  return { command: positionals[0], values };
}
