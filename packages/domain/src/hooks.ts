// Hooks por fase (docs/design.md §Hooks por fase, ADR uw-10-hooks): orden, ajustes por defecto y
// resultado de un punto. Leer la rama base y ejecutar los scripts es de adapters y server.
import {
  type HookPoint,
  type HookPointOutcome,
  type HookPolicy,
  HooksConfig,
  type Phase,
} from "@lunasq/schemas";

export const HOOKS_DIR = "lunasq/hooks";
export const HOOKS_CONFIG_PATH = `${HOOKS_DIR}/config`;

export const DEFAULT_HOOK_POLICY: HookPolicy = "block";
export const DEFAULT_HOOK_TIMEOUT_SECONDS = 10 * 60;

export type HooksConfigResult = { ok: true; config: HooksConfig } | { ok: false; message: string };

/** `text` es el contenido de lunasq/hooks/config; sin archivo, todos los scripts usan los defaults. */
export function parseHooksConfig(text: string | undefined): HooksConfigResult {
  if (text === undefined) return { ok: true, config: {} };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, message: `${HOOKS_CONFIG_PATH} no es JSON válido: ${String(err)}` };
  }
  const parsed = HooksConfig.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return { ok: false, message: `${HOOKS_CONFIG_PATH} inválido: ${issues.join("; ")}` };
  }
  return { ok: true, config: parsed.data };
}

export interface PlannedHook {
  script: string;
  policy: HookPolicy;
  timeoutSeconds: number;
}

/**
 * Scripts del punto en el orden en que corren: alfabético por nombre de archivo (por unidades de
 * código, sin locale, para que un prefijo numérico defina la secuencia en cualquier máquina).
 */
export function planHooks(
  point: HookPoint,
  scripts: readonly string[],
  config: HooksConfig,
): PlannedHook[] {
  const settings = config[point] ?? {};
  return [...scripts]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((script) => ({
      script,
      policy: settings[script]?.policy ?? DEFAULT_HOOK_POLICY,
      timeoutSeconds: settings[script]?.timeoutSeconds ?? DEFAULT_HOOK_TIMEOUT_SECONDS,
    }));
}

/** Un script con política block que falla detiene el punto: los siguientes no corren. */
export function hookStopsPoint(hook: { policy: HookPolicy; passed: boolean }): boolean {
  return !hook.passed && hook.policy === "block";
}

export function hookPointOutcome(
  results: readonly { policy: HookPolicy; passed: boolean }[],
): HookPointOutcome {
  if (results.some(hookStopsPoint)) return "blocked";
  return results.some((r) => !r.passed) ? "warned" : "passed";
}

const POINT_PHASE: Record<HookPoint, Phase | null> = {
  before_refinement: "refine",
  after_refinement: "refine",
  before_implementation: "implement",
  after_implementation: "implement",
  before_verification: "verify",
  after_verification: "verify",
  before_delivery: "deliver",
  after_delivery: "deliver",
  after_merge: null,
  on_failure: null,
};

export function hookPointPhase(point: HookPoint): Phase | null {
  return POINT_PHASE[point];
}

/** after_merge corre en el checkout de la rama base del proyecto; los demás, en el worktree. */
export function hookPointRunsInWorktree(point: HookPoint): boolean {
  return point !== "after_merge";
}

/**
 * Si un fallo con política block manda la tarea a needs_human. after_merge llega con la tarea ya
 * terminada y on_failure con el Run ya fallido: ahí el fallo solo se registra.
 */
export function hookPointEscalates(point: HookPoint): boolean {
  return point !== "after_merge" && point !== "on_failure";
}
