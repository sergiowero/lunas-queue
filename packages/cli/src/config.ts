// Configuración de la instalación (`~/.lunasq/config.json`): el puerto del proceso y si se pasa
// la telemetría a los panes. La URL del LunasQ MCP y de los hooks sale del puerto.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_HOSTNAME } from "@lunasq/server";

export const DEFAULT_PORT = 7360;

export interface LunasqConfig {
  port: number;
  telemetry: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}

export function parseConfig(value: unknown): LunasqConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError("la configuración debe ser un objeto JSON");
  }
  const { port = DEFAULT_PORT, telemetry = true } = value as Record<string, unknown>;
  if (!isPort(port)) throw new ConfigError(`port inválido: ${JSON.stringify(port)}`);
  if (typeof telemetry !== "boolean") {
    throw new ConfigError(`telemetry inválido: ${JSON.stringify(telemetry)}`);
  }
  return { port, telemetry };
}

/** `undefined` si el archivo no existe; ConfigError si no es válido. */
export async function readConfig(path: string): Promise<LunasqConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} no es JSON válido`);
  }
  return parseConfig(json);
}

export async function writeConfig(path: string, config: LunasqConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
  await rename(tmp, path);
}

export const baseUrl = (config: LunasqConfig) => `http://${DEFAULT_HOSTNAME}:${config.port}`;
