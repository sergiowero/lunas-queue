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

/**
 * Read-only commands a reviewer may run to inspect the diff and the repository. Each command is listed
 * exactly and with arguments (`git diff` / `git diff *`), never as a prefix glob, so `git difftool`
 * and similar programs that run other programs do not match. `git grep` and `rg` are left out on
 * purpose (`-O`/`--open-files-in-pager` and `--pre` execute commands); the reviewer has the `grep`
 * and `glob` tools instead.
 */
const REVIEWER_READ_ONLY_COMMANDS = [
  "git diff",
  "git log",
  "git show",
  "git status",
  "git ls-files",
  "git blame",
  "git rev-parse",
  "git merge-base",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
].flatMap((command) => [command, `${command} *`]);

/**
 * Patterns denied after the allowlist (the last matching rule wins): flags that write a file or run
 * an external program, and shell redirections.
 */
const REVIEWER_DENIED_PATTERNS = [
  "*--output*",
  "*--ext-diff*",
  "*--textconv*",
  "*--open-files-in-pager*",
  "*--extcmd*",
  "*--pre*",
  "*>*",
];

/** Environment variable that makes OpenCode ignore `opencode.json` and `.opencode/` of the worktree. */
export const OPENCODE_DISABLE_PROJECT_CONFIG_ENV = "OPENCODE_DISABLE_PROJECT_CONFIG";

/**
 * Config for a reviewer: it cannot modify the worktree (no edits, only an allowlist of read-only
 * commands), cannot leave it, and has no MCP server and no network tools.
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
      bash: {
        "*": "deny",
        ...Object.fromEntries(REVIEWER_READ_ONLY_COMMANDS.map((c) => [c, "allow"])),
        ...Object.fromEntries(REVIEWER_DENIED_PATTERNS.map((c) => [c, "deny"])),
      },
      external_directory: "deny",
      webfetch: "deny",
      websearch: "deny",
    },
  };
}
