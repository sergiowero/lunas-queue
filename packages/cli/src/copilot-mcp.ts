import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lunasqServer(url: string) {
  return { type: "http", url };
}

async function readConfig(path: string): Promise<JsonObject> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`la configuración MCP de Copilot no es JSON válido (${path})`, {
      cause: error,
    });
  }
  if (!isObject(parsed))
    throw new Error(`la configuración MCP de Copilot debe ser un objeto (${path})`);
  return parsed;
}

function mergeConfig(existing: JsonObject, url: string): JsonObject {
  const servers = existing.mcpServers;
  if (servers !== undefined && !isObject(servers)) {
    throw new Error("mcpServers en la configuración de Copilot debe ser un objeto");
  }
  return {
    ...existing,
    mcpServers: { ...(servers ?? {}), lunasq: lunasqServer(url) },
  };
}

/** Registra solo el servidor LunasQ y conserva todas las demás opciones/entradas del usuario. */
export async function ensureCopilotMcpConfig(
  path: string,
  url: string,
): Promise<{ written: boolean }> {
  const current = await readConfig(path);
  const next = mergeConfig(current, url);
  if (JSON.stringify(current) === JSON.stringify(next)) return { written: false };

  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return { written: true };
}

export async function hasCopilotMcpConfig(path: string, url: string): Promise<boolean> {
  let current: JsonObject;
  try {
    current = await readConfig(path);
  } catch {
    return false;
  }
  return (
    isObject(current.mcpServers) &&
    isObject(current.mcpServers.lunasq) &&
    current.mcpServers.lunasq.type === "http" &&
    current.mcpServers.lunasq.url === url
  );
}
