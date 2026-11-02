// Stable MCP configuration file (ADR 0002): one per installation, with the run token as
// `${LUNASQ_RUN_TOKEN}`, which Claude Code expands from the pane's environment. The token never touches disk.
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

/** Writes the file only if missing or changed; idempotent. */
export function ensureMcpConfig(path: string, url: string): Promise<{ written: boolean }> {
  return ensureJsonFile(path, mcpConfig(url));
}
