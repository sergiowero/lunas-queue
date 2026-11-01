// Configuración global de proveedores de agente (docs/decisions/settings-proveedores.md): el
// humano habilita o deshabilita cada AgentKind desde el panel de Settings. Sin configuración
// guardada, todos están habilitados.
import { z } from "zod";
import { AgentKind } from "./enums.ts";

export const AgentProviderSettings = z.strictObject(
  Object.fromEntries(AgentKind.options.map((kind) => [kind, z.boolean().default(true)])) as Record<
    AgentKind,
    z.ZodDefault<z.ZodBoolean>
  >,
);
export type AgentProviderSettings = z.infer<typeof AgentProviderSettings>;

export const SETTINGS_UPDATED = "settings.updated";

export const SettingsUpdatedPayload = z.strictObject({ providers: AgentProviderSettings });
export type SettingsUpdatedPayload = z.infer<typeof SettingsUpdatedPayload>;
