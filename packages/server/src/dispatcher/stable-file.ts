// Stable files the dispatcher passes to Claude Code (MCP, settings): one per installation,
// without Run data, so dispatching neither creates nor cleans files.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Writes the JSON only if missing or changed; idempotent. */
export async function ensureJsonFile(path: string, value: unknown): Promise<{ written: boolean }> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === content) return { written: false };
  await mkdir(dirname(path), { recursive: true });
  // Atomic rename: an agent that starts never reads a half-written file.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
  return { written: true };
}
