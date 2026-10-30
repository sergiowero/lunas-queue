// Archivo de configuración MCP estable (ADR 0002): uno por instalación, con el run token como
// `${LUNASQ_RUN_TOKEN}`, que Claude Code expande del entorno del pane. El token nunca toca disco.
import { RUN_ENV, RUN_TOKEN_HEADER } from "@lunasq/schemas";
import { ensureJsonFile } from "./stable-file.ts";

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
export function ensureMcpConfig(path: string, url: string): Promise<{ written: boolean }> {
  return ensureJsonFile(path, mcpConfig(url));
}
