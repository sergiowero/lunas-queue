// Enabled agent providers (docs/decisions/settings-proveedores.md). The human decides
// from Settings which ones may receive new dispatches; a profile model whose provider is disabled is
// skipped (docs/decisions/agent-profiles.md).
import { AgentKind, type AgentProviderSettings } from "@lunasq/schemas";

/** Without saved configuration, every provider is considered enabled. */
export const ALL_PROVIDERS_ENABLED: AgentProviderSettings = Object.fromEntries(
  AgentKind.options.map((kind) => [kind, true]),
) as AgentProviderSettings;
