// What `install` and `doctor` need from the machine; tests pass a temporary home and a fake.
import { homedir } from "node:os";
import {
  type ProcessResult,
  type ProcessRunner,
  prepareDatabase,
  ShellProcessRunner,
} from "@lunasq/server";
import { findAssetsRoot, findWebRoot } from "./assets.ts";
import { type Paths, resolvePaths } from "./paths.ts";

export interface MachineContext {
  paths: Paths;
  /** Folder with `skills/` and `agents/` (the assets of the repo or the published package). */
  assetsRoot: string;
  /** Front end build, if it exists (ADR uw-29-e2e). */
  webRoot?: string | undefined;
  runner: ProcessRunner;
  nodeVersion: string;
  /** Throws if better-sqlite3 does not load or the migrations do not apply. */
  checkSqlite: () => void;
}

/** Cap per command: a hung tool must not hang `doctor`. */
export const COMMAND_TIMEOUT_MS = 30_000;

export function machineContext(): MachineContext {
  return {
    paths: resolvePaths(),
    assetsRoot: findAssetsRoot(),
    webRoot: findWebRoot(),
    runner: new ShellProcessRunner(),
    nodeVersion: process.versions.node,
    checkSqlite: () => prepareDatabase(":memory:").$client.close(),
  };
}

export function run(ctx: MachineContext, command: string): Promise<ProcessResult> {
  return ctx.runner.run({ command, cwd: homedir(), timeoutMs: COMMAND_TIMEOUT_MS });
}

/** `sh -c` exits with 127 if the command does not exist. */
export const NOT_FOUND_EXIT_CODE = 127;
