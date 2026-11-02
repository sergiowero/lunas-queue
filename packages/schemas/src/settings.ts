// Configuración global (docs/decisions/settings-proveedores.md): el humano habilita o deshabilita
// cada AgentKind y fija el límite global de agentes concurrentes desde el panel de Settings. Sin
// configuración guardada, todos los proveedores están habilitados y rige el default de
// SchedulerConfig para la concurrencia.
import { z } from "zod";
import { AgentKind } from "./enums.ts";

export const AgentProviderSettings = z.strictObject(
  Object.fromEntries(AgentKind.options.map((kind) => [kind, z.boolean().default(true)])) as Record<
    AgentKind,
    z.ZodDefault<z.ZodBoolean>
  >,
);
export type AgentProviderSettings = z.infer<typeof AgentProviderSettings>;

/**
 * Cambio parcial de la configuración: solo los proveedores que trae. Cada interruptor de la UI
 * envía solo el suyo, así dos pestañas no se pisan el cambio del otro proveedor.
 */
export const AgentProviderPatch = z.strictObject(
  Object.fromEntries(AgentKind.options.map((kind) => [kind, z.boolean().optional()])) as Record<
    AgentKind,
    z.ZodOptional<z.ZodBoolean>
  >,
);
export type AgentProviderPatch = z.infer<typeof AgentProviderPatch>;

export const MAX_GLOBAL_CONCURRENCY = 50;

/** Límite global de agentes vivos guardado en Settings: entero de 1 a 50. */
export const ConcurrencySettings = z.strictObject({
  globalConcurrency: z.int().min(1).max(MAX_GLOBAL_CONCURRENCY),
});
export type ConcurrencySettings = z.infer<typeof ConcurrencySettings>;

export const SETTINGS_UPDATED = "settings.updated";

/** Lo que cambió: los proveedores, el límite de concurrencia o ambos (al menos uno). */
export const SettingsUpdatedPayload = z
  .strictObject({
    providers: AgentProviderSettings.optional(),
    globalConcurrency: ConcurrencySettings.shape.globalConcurrency.optional(),
  })
  .refine((p) => p.providers !== undefined || p.globalConcurrency !== undefined, {
    message: "settings.updated necesita providers o globalConcurrency",
  });
export type SettingsUpdatedPayload = z.infer<typeof SettingsUpdatedPayload>;
