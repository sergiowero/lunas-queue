// Inline OpenCode configuration LunasQ hands to each OpenCode process through the environment
// variable `OPENCODE_CONFIG_CONTENT` (docs/decisions/opencode-provider.md). It is never written to
// OpenCode's global or project config files, and it never contains the run token: the header reads
// `{env:LUNASQ_RUN_TOKEN}`, which OpenCode substitutes from the pane's environment.
import { RUN_ENV, RUN_TOKEN_HEADER } from "@lunasq/schemas";

/** Environment variable OpenCode reads an inline JSON config from. */
export const OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT";

/** Agent whose model and variant the TUI uses by default. */
const PHASE_AGENT = "build";

export type OpencodePhaseConfigInput = {
  /** URL of the LunasQ MCP server. */
  mcpUrl: string;
  /** `provider/model`, as the profile model carries it. */
  model?: string | undefined;
  /** The profile's effort: OpenCode's model variant. */
  effort?: string | undefined;
};

/**
 * Config for a phase agent: the remote LunasQ MCP server authenticated with the Run's token, edits and
 * commands allowed without prompting, and no access outside the worktree.
 *
 * OpenCode's TUI has no flag for the model variant, so the effort is set as the default variant of the
 * agent; OpenCode applies it only to the agent's own model, which is therefore set to the same model.
 */
export function opencodePhaseConfig(input: OpencodePhaseConfigInput): Record<string, unknown> {
  return {
    mcp: {
      lunasq: {
        type: "remote",
        url: input.mcpUrl,
        enabled: true,
        headers: { [RUN_TOKEN_HEADER]: `{env:${RUN_ENV.runToken}}` },
      },
    },
    permission: {
      edit: "allow",
      bash: "allow",
      external_directory: "deny",
      "lunasq_*": "allow",
    },
    ...(input.effort === undefined
      ? {}
      : {
          agent: {
            [PHASE_AGENT]: {
              ...(input.model === undefined ? {} : { model: input.model }),
              variant: input.effort,
            },
          },
        }),
  };
}

/** Environment variable that makes OpenCode ignore `opencode.json` and `.opencode/` of the worktree. */
export const OPENCODE_DISABLE_PROJECT_CONFIG_ENV = "OPENCODE_DISABLE_PROJECT_CONFIG";

/**
 * Config for a reviewer: it cannot modify the worktree, cannot leave it, and has no MCP server and no
 * network tools. It has no shell at all: OpenCode matches `bash` rules against each simple command
 * and not against its redirections, so no pattern can stop `{ git log; } > file`; the reviewer reads
 * with `read`, `grep`, `glob` and `list`, and the approver puts the diff in its instructions.
 */
export function opencodeReviewerConfig(): Record<string, unknown> {
  return {
    permission: {
      "*": "deny",
      read: "allow",
      grep: "allow",
      glob: "allow",
      list: "allow",
      edit: "deny",
      bash: "deny",
      external_directory: "deny",
      webfetch: "deny",
      websearch: "deny",
    },
  };
}
