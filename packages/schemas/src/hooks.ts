// Hooks por fase (docs/design.md §Hooks por fase, ADR uw-10-hooks). Los scripts viven en
// lunasq/hooks/<punto>/ del repo del proyecto y su timeout y política en lunasq/hooks/config
// (JSON); LunasQ los lee siempre de la rama base.
import { z } from "zod";

export const HookPoint = z.enum([
  "before_refinement",
  "after_refinement",
  "before_implementation",
  "after_implementation",
  "before_verification",
  "after_verification",
  "before_delivery",
  "after_delivery",
  "after_merge",
  "on_failure",
]);
export type HookPoint = z.infer<typeof HookPoint>;

/** `block` detiene la transición y manda la tarea a needs_human; `warn` solo se registra. */
export const HookPolicy = z.enum(["block", "warn"]);
export type HookPolicy = z.infer<typeof HookPolicy>;

// setTimeout trata más de 2^31-1 ms como 1 ms; una semana queda muy por debajo.
export const MAX_HOOK_TIMEOUT_SECONDS = 7 * 24 * 3600;

/** Un nombre de archivo dentro del directorio del punto, sin rutas. */
export const HookScriptName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\0]+$/, "el nombre del script no puede tener /")
  .refine((name) => name !== "." && name !== "..", "nombre de script inválido");

export const HookSettings = z.strictObject({
  timeoutSeconds: z.int().min(1).max(MAX_HOOK_TIMEOUT_SECONDS).optional(),
  policy: HookPolicy.optional(),
});
export type HookSettings = z.infer<typeof HookSettings>;

/** Contenido de lunasq/hooks/config: por punto, los ajustes de cada script que no usa los defaults. */
export const HooksConfig = z.partialRecord(HookPoint, z.record(HookScriptName, HookSettings));
export type HooksConfig = z.infer<typeof HooksConfig>;

export const HOOK_EXECUTED = "hook.executed";
export const HOOK_POINT_COMPLETED = "hook.point_completed";

/** Cuánto de la salida de un hook entra en su evento: el final, que es donde está el error. */
export const HOOK_OUTPUT_LIMIT = 16 * 1024;

const commitSha = z.string().regex(/^[0-9a-f]{40}$/, "sha de commit");

export const HookExecutedPayload = z.strictObject({
  point: HookPoint,
  script: HookScriptName,
  // Commit de la rama base del que se leyó el script.
  baseRef: commitSha,
  runId: z.string().min(1).nullable(),
  policy: HookPolicy,
  timeoutSeconds: z.int().min(1),
  exitCode: z.int(),
  timedOut: z.boolean(),
  durationMs: z.int().min(0),
  passed: z.boolean(),
  // stdout y stderr juntos, recortados al final.
  output: z.string().max(HOOK_OUTPUT_LIMIT),
});
export type HookExecutedPayload = z.infer<typeof HookExecutedPayload>;

export const HookPointOutcome = z.enum(["passed", "warned", "blocked"]);
export type HookPointOutcome = z.infer<typeof HookPointOutcome>;

export const HookPointCompletedPayload = z.strictObject({
  point: HookPoint,
  // null si no se pudo leer la rama base.
  baseRef: commitSha.nullable(),
  runId: z.string().min(1).nullable(),
  outcome: HookPointOutcome,
  // Script con política block que falló, si lo hubo.
  failedScript: HookScriptName.nullable(),
  // Fallo antes de correr scripts: fetch de la base o config inválida.
  error: z.string().min(1).max(2000).nullable(),
  // Commit con los cambios que dejaron los hooks, con los trailers de la tarea.
  commit: commitSha.nullable(),
  // Los hooks dejaron cambios pero el worktree ya tenía cambios sin commit: no se commiteó.
  commitSkipped: z.boolean(),
});
export type HookPointCompletedPayload = z.infer<typeof HookPointCompletedPayload>;
