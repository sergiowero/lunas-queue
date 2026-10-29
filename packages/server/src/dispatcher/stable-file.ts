// Archivos estables que el dispatcher pasa a Claude Code (MCP, settings): uno por instalación,
// sin datos del Run, así despachar no crea ni limpia archivos.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Escribe el JSON solo si falta o cambió; idempotente. */
export async function ensureJsonFile(path: string, value: unknown): Promise<{ written: boolean }> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === content) return { written: false };
  await mkdir(dirname(path), { recursive: true });
  // Rename atómico: un agente que arranca nunca lee el archivo a medias.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
  return { written: true };
}
