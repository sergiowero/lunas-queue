import type { AgentKind, AgentProfile } from "@lunasq/schemas";

export type AgentProviderContext = {
  mcpConfigPath: string;
  settingsPath: string;
  sessionId: string;
};

export type AgentProvider = {
  kind: AgentKind;
  capabilities: {
    usage: "reported" | "unavailable";
    reviewerExecution: "native-hooks" | "lunasq-runner";
  };
  args(profile: AgentProfile, context: AgentProviderContext): string[];
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
      throw new AgentProviderError("hay proveedores de agente duplicados");
    }
    this.#providers = new Map(entries);
  }

  get(kind: AgentKind): AgentProvider {
    const provider = this.#providers.get(kind);
    if (!provider) throw new AgentProviderError(`no hay adapter registrado para ${kind}`);
    return provider;
  }

  /** Proveedor primario primero, seguido por los demás en el orden de registro. */
  fallbackOrder(primary: AgentKind): AgentProvider[] {
    const first = this.get(primary);
    return [first, ...[...this.#providers.values()].filter((provider) => provider !== first)];
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
];

function assertNoReservedArgs(args: string[], flags: string[]): void {
  const clash = args.find((arg) =>
    flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
  if (clash !== undefined) {
    throw new AgentProviderError(`el perfil de agente no puede traer ${clash}: lo fija LunasQ`);
  }
}

function assertEffortNotDuplicated(profile: AgentProfile): void {
  if (
    profile.effort &&
    profile.args.some((arg) => arg === "--effort" || arg.startsWith("--effort="))
  ) {
    throw new AgentProviderError("el perfil fija effort y también trae --effort en args: deja uno");
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
    assertEffortNotDuplicated(profile);
    return [
      ...(profile.model === undefined ? [] : ["--model", profile.model]),
      ...(profile.effort === undefined ? [] : ["--reasoning-effort", profile.effort]),
      ...profile.args,
      "--allow-all-tools",
      "--trust-folder",
      "--session-id",
      context.sessionId,
      "--additional-mcp-config",
      `@${context.mcpConfigPath}`,
    ];
  },
};

export const agentProviders = new AgentProviderRegistry([claudeProvider, copilotProvider]);
