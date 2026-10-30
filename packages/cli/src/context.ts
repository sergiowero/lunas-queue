// Lo que `install` y `doctor` necesitan de la máquina; los tests pasan un home temporal y un fake.
import { homedir } from "node:os";
import {
  type ProcessResult,
  type ProcessRunner,
  prepareDatabase,
  ShellProcessRunner,
} from "@lunasq/server";
import { findAssetsRoot } from "./assets.ts";
import { type Paths, resolvePaths } from "./paths.ts";

export interface MachineContext {
  paths: Paths;
  /** Carpeta con `skills/` y `agents/` (los assets del repo o del paquete publicado). */
  assetsRoot: string;
  runner: ProcessRunner;
  nodeVersion: string;
  /** Lanza si better-sqlite3 no carga o las migraciones no aplican. */
  checkSqlite: () => void;
}

/** Tope por comando: una herramienta colgada no debe colgar `doctor`. */
export const COMMAND_TIMEOUT_MS = 30_000;

export function machineContext(): MachineContext {
  return {
    paths: resolvePaths(),
    assetsRoot: findAssetsRoot(),
    runner: new ShellProcessRunner(),
    nodeVersion: process.versions.node,
    checkSqlite: () => prepareDatabase(":memory:").$client.close(),
  };
}

export function run(ctx: MachineContext, command: string): Promise<ProcessResult> {
  return ctx.runner.run({ command, cwd: homedir(), timeoutMs: COMMAND_TIMEOUT_MS });
}

/** `sh -c` sale con 127 si el comando no existe. */
export const NOT_FOUND_EXIT_CODE = 127;
