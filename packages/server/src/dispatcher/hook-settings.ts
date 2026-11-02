// Stable settings file with the SubagentStart and SubagentStop hooks (docs/design.md
// §Verification with subagents, ADR uw-19-revisores). They are `http` hooks to LunasQ's
// endpoint; the run token goes in the header as `$LUNASQ_RUN_TOKEN`, which Claude Code expands from the
// pane's environment only because it is in `allowedEnvVars`. The token never touches disk (ADR 0002).
import { RUN_ENV, RUN_TOKEN_HEADER } from "@lunasq/schemas";
import { ensureJsonFile } from "./stable-file.ts";

/** Seconds Claude Code waits for the hook's response; the endpoint only writes one row. */
const HOOK_TIMEOUT_SECONDS = 10;

export function hookSettings(url: string) {
  const hook = {
    type: "http",
    url,
    headers: { [RUN_TOKEN_HEADER]: `$${RUN_ENV.runToken}` },
    allowedEnvVars: [RUN_ENV.runToken],
    timeout: HOOK_TIMEOUT_SECONDS,
  };
  return {
    hooks: {
      SubagentStart: [{ hooks: [hook] }],
      SubagentStop: [{ hooks: [hook] }],
    },
  };
}

/** Writes the file only if missing or changed; idempotent. */
export function ensureHookSettings(path: string, url: string): Promise<{ written: boolean }> {
  return ensureJsonFile(path, hookSettings(url));
}
