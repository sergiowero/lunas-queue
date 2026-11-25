import type { AgentKind, ProfileModel } from "@lunasq/schemas";

export type AgentProviderContext = {
  mcpConfigPath: string;
  mcpUrl?: string;
  settingsPath: string;
  sessionId: string;
};

export type AgentProvider = {
  kind: AgentKind;
  capabilities: {
    usage: "reported" | "unavailable";
    reviewerExecution: "native-hooks" | "lunasq-runner";
  };
  args(profile: ProfileModel, context: AgentProviderContext): string[];
};

export class AgentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProviderError";
  }
}

export class AgentProviderRegistry {
  readonly #providers: ReadonlyMap<AgentKind, AgentProvider>;

  constructor(providers: readonly AgentProvider[]) {
    const entries = providers.map((provider) => [provider.kind, provider] as const);
    if (new Set(entries.map(([kind]) => kind)).size !== entries.length) {
      throw new AgentProviderError("there are duplicate agent providers");
    }
    this.#providers = new Map(entries);
  }

  get(kind: AgentKind): AgentProvider {
    const provider = this.#providers.get(kind);
    if (!provider) throw new AgentProviderError(`no adapter registered for ${kind}`);
    return provider;
  }

  all(): AgentProvider[] {
    return [...this.#providers.values()];
  }
}

const RESERVED_CLAUDE_FLAGS = ["--mcp-config", "--strict-mcp-config", "--settings", "--session-id"];
const RESERVED_COPILOT_FLAGS = [
  "--additional-mcp-config",
  "--session-id",
  "--model",
  "--reasoning-effort",
  "--allow-all-tools",
  "--trust-folder",
  "--autopilot",
  "--mode",
  "--plan",
];
const RESERVED_CODEX_FLAGS = [
  "--model",
  "-m",
  "--config",
  "-c",
  "--sandbox",
  "-s",
  "--ask-for-approval",
  "-a",
  "--approve-for-me",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--worktree",
  "--cd",
  "-C",
  "--add-dir",
  "--profile",
  "-p",
  "--ignore-user-config",
  "--strict-config",
];

const RESERVED_OPENCODE_FLAGS = [
  "--model",
  "-m",
  "--auto",
  "--port",
  "--hostname",
  "--mdns",
  "--mdns-domain",
  "--continue",
  "-c",
  "--session",
  "-s",
  "--fork",
  "--prompt",
  "--agent",
  "--pure",
  "--variant",
];

function assertNoReservedArgs(args: string[], flags: string[]): void {
  const clash = args.find((arg) =>
    flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
  if (clash !== undefined) {
    throw new AgentProviderError(`the agent profile cannot carry ${clash}: LunasQ sets it`);
  }
}

/** `--` turns off flag parsing: the fixed LunasQ flags would become positional. */
function assertNoOptionTerminator(args: string[]): void {
  if (args.includes("--")) {
    throw new AgentProviderError(
      "the agent profile cannot carry --: it would disable the flags LunasQ sets",
    );
  }
}

function assertEffortNotDuplicated(profile: ProfileModel): void {
  if (
    profile.effort &&
    profile.args.some((arg) => arg === "--effort" || arg.startsWith("--effort="))
  ) {
    throw new AgentProviderError(
      "the profile sets effort and also carries --effort in args: keep one",
    );
  }
}

const claudeProvider: AgentProvider = {
  kind: "claude",
  capabilities: { usage: "reported", reviewerExecution: "native-hooks" },
  args(profile, context) {
    assertNoReservedArgs(
      profile.args,
      profile.model === undefined ? RESERVED_CLAUDE_FLAGS : [...RESERVED_CLAUDE_FLAGS, "--model"],
    );
    assertEffortNotDuplicated(profile);
    return [
      ...(profile.model === undefined ? [] : ["--model", profile.model]),
      ...(profile.effort === undefined ? [] : ["--effort", profile.effort]),
      ...profile.args,
      "--mcp-config",
      context.mcpConfigPath,
      "--strict-mcp-config",
      "--settings",
      context.settingsPath,
      "--session-id",
      context.sessionId,
    ];
  },
};

const copilotProvider: AgentProvider = {
  kind: "copilot",
  capabilities: { usage: "unavailable", reviewerExecution: "lunasq-runner" },
  args(profile, context) {
    assertNoReservedArgs(profile.args, RESERVED_COPILOT_FLAGS);
    assertNoOptionTerminator(profile.args);
    assertEffortNotDuplicated(profile);
    return [
      ...(profile.model === undefined ? [] : ["--model", profile.model]),
      ...(profile.effort === undefined ? [] : ["--reasoning-effort", profile.effort]),
      ...profile.args,
      "--autopilot",
      "--allow-all-tools",
      // Copilot rejects --trust-folder together with --session-id; LunasQ supplies MCP explicitly.
      "--session-id",
      context.sessionId,
      "--additional-mcp-config",
      `@${context.mcpConfigPath}`,
    ];
  },
};

const codexProvider: AgentProvider = {
  kind: "codex",
  capabilities: { usage: "unavailable", reviewerExecution: "lunasq-runner" },
  args(profile, context) {
    assertNoReservedArgs(profile.args, RESERVED_CODEX_FLAGS);
    assertNoOptionTerminator(profile.args);
    assertEffortNotDuplicated(profile);
    if (!context.mcpUrl) {
      throw new AgentProviderError("the LunasQ MCP URL is missing to configure Codex CLI");
    }
    return [
      ...(profile.model === undefined ? [] : ["--model", profile.model]),
      ...(profile.effort === undefined
        ? []
        : ["--config", `model_reasoning_effort=${JSON.stringify(profile.effort)}`]),
      ...profile.args,
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "--config",
      `mcp_servers.lunasq.url=${JSON.stringify(context.mcpUrl)}`,
      "--config",
      'mcp_servers.lunasq.env_http_headers={"X-LunasQ-Run-Token"="LUNASQ_RUN_TOKEN"}',
      "--config",
      'mcp_servers.lunasq.default_tools_approval_mode="approve"',
    ];
  },
};

/**
 * OpenCode's TUI takes the model with `--model`; it has no flag for the model variant (the effort),
 * which LunasQ sets in the per-Run inline config (`opencodePhaseConfig`). The permissions and the
 * LunasQ MCP server also live in that config, so no flag disables approvals or carries a secret.
 */
const opencodeProvider: AgentProvider = {
  kind: "opencode",
  capabilities: { usage: "unavailable", reviewerExecution: "lunasq-runner" },
  args(profile) {
    assertNoReservedArgs(profile.args, RESERVED_OPENCODE_FLAGS);
    assertNoOptionTerminator(profile.args);
    return [...(profile.model === undefined ? [] : ["--model", profile.model]), ...profile.args];
  },
};

export const agentProviders = new AgentProviderRegistry([
  claudeProvider,
  copilotProvider,
  codexProvider,
  opencodeProvider,
]);

/**
 * Checks a profile model against its provider's reserved flags (the ones LunasQ sets itself) without
 * building a command line. Throws `AgentProviderError` naming the conflicting flag.
 */
export function validateProfileModel(model: ProfileModel): void {
  agentProviders.get(model.kind).args(model, {
    mcpConfigPath: "/validate/mcp.json",
    mcpUrl: "http://127.0.0.1/validate",
    settingsPath: "/validate/settings.json",
    sessionId: "validate",
  });
}
