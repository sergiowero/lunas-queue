// Enabled agent providers (docs/decisions/settings-proveedores.md). The human decides
// from Settings which ones may receive new dispatches; the fallback order is the primary of the
// phase profile and then the other AgentKind in registration order, filtered by enabled.
import { AgentKind, type AgentProviderSettings } from "@lunasq/schemas";

/** Without saved configuration, every provider is considered enabled. */
export const ALL_PROVIDERS_ENABLED: AgentProviderSettings = Object.fromEntries(
  AgentKind.options.map((kind) => [kind, true]),
) as AgentProviderSettings;

/** Primary first and then the others in registration order, only the enabled ones. */
export function enabledFallbackOrder(
  primary: AgentKind,
  enabled: AgentProviderSettings,
): AgentKind[] {
  return [primary, ...AgentKind.options.filter((kind) => kind !== primary)].filter(
    (kind) => enabled[kind],
  );
}

/** The primary if enabled; otherwise the first enabled one of the fallback; null if none. */
export function effectiveAgentKind(
  primary: AgentKind,
  enabled: AgentProviderSettings,
): AgentKind | null {
  return enabledFallbackOrder(primary, enabled)[0] ?? null;
}
