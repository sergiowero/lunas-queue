// Proveedores de agente habilitados (docs/decisions/settings-proveedores.md). El humano decide
// desde Settings cuáles pueden recibir despachos nuevos; el orden de fallback es el primario del
// perfil de la fase y luego los demás AgentKind en orden de registro, filtrado por habilitados.
import { AgentKind, type AgentProviderSettings } from "@lunasq/schemas";

/** Sin configuración guardada, todos los proveedores se consideran habilitados. */
export const ALL_PROVIDERS_ENABLED: AgentProviderSettings = Object.fromEntries(
  AgentKind.options.map((kind) => [kind, true]),
) as AgentProviderSettings;

/** Primario primero y después los demás en orden de registro, solo los habilitados. */
export function enabledFallbackOrder(
  primary: AgentKind,
  enabled: AgentProviderSettings,
): AgentKind[] {
  return [primary, ...AgentKind.options.filter((kind) => kind !== primary)].filter(
    (kind) => enabled[kind],
  );
}

/** El primario si está habilitado; si no, el primero habilitado del fallback; null si ninguno. */
export function effectiveAgentKind(
  primary: AgentKind,
  enabled: AgentProviderSettings,
): AgentKind | null {
  return enabledFallbackOrder(primary, enabled)[0] ?? null;
}
