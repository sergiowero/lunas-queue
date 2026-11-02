// Global configuration (docs/decisions/settings-proveedores.md): the human enables or disables
// each AgentKind and sets the global limit of concurrent agents from the Settings panel. Without
// saved configuration, all providers are enabled and the default of
// SchedulerConfig applies for concurrency.
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
 * Partial change of the configuration: only the providers it carries. Each switch of the UI
 * sends only its own, so two tabs do not overwrite the other provider's change.
 */
export const AgentProviderPatch = z.strictObject(
  Object.fromEntries(AgentKind.options.map((kind) => [kind, z.boolean().optional()])) as Record<
    AgentKind,
    z.ZodOptional<z.ZodBoolean>
  >,
);
export type AgentProviderPatch = z.infer<typeof AgentProviderPatch>;

export const MAX_GLOBAL_CONCURRENCY = 50;

/** Global limit of live agents saved in Settings: integer from 1 to 50. */
export const ConcurrencySettings = z.strictObject({
  globalConcurrency: z.int().min(1).max(MAX_GLOBAL_CONCURRENCY),
});
export type ConcurrencySettings = z.infer<typeof ConcurrencySettings>;

export const MAX_VERIFICATION_ITERATIONS = 20;

/**
 * Global cap of verification reworks saved in Settings: integer from 1 to 20. A project's
 * `limits.maxVerificationIterations` overrides it.
 */
export const VerificationSettings = z.strictObject({
  maxVerificationIterations: z.int().min(1).max(MAX_VERIFICATION_ITERATIONS),
});
export type VerificationSettings = z.infer<typeof VerificationSettings>;

export const SETTINGS_UPDATED = "settings.updated";

/** What changed: the providers, the concurrency limit, the iteration cap or several (at least one). */
export const SettingsUpdatedPayload = z
  .strictObject({
    providers: AgentProviderSettings.optional(),
    globalConcurrency: ConcurrencySettings.shape.globalConcurrency.optional(),
    maxVerificationIterations: VerificationSettings.shape.maxVerificationIterations.optional(),
  })
  .refine(
    (p) =>
      p.providers !== undefined ||
      p.globalConcurrency !== undefined ||
      p.maxVerificationIterations !== undefined,
    { message: "settings.updated needs providers, globalConcurrency or maxVerificationIterations" },
  );
export type SettingsUpdatedPayload = z.infer<typeof SettingsUpdatedPayload>;
