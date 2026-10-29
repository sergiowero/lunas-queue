// Archivo de configuración MCP estable (ADR 0002): uno por instalación, con el run token como
// `${LUNASQ_RUN_TOKEN}`, que Claude Code expande del entorno del pane. El token nunca toca disco.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { RUN_ENV, RUN_TOKEN_HEADER } from "@lunasq/schemas";

export function mcpConfig(url: string) {
  return {
    mcpServers: {
      lunasq: {
        type: "http",
        url,
        headers: { [RUN_TOKEN_HEADER]: `\${${RUN_ENV.runToken}}` },
      },
    },
  };
}

/** Escribe el archivo solo si falta o cambió; idempotente. */
export async function ensureMcpConfig(path: string, url: string): Promise<{ written: boolean }> {
  const content = `${JSON.stringify(mcpConfig(url), null, 2)}\n`;
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === content) return { written: false };
  await mkdir(dirname(path), { recursive: true });
  // Rename atómico: un agente que arranca nunca lee el archivo a medias.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
  return { written: true };
}
