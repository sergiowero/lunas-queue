// Hooks per phase (docs/design.md §Hooks per phase, ADR uw-10-hooks): order, default settings and
// result of a point. Reading the base branch and running the scripts belong to adapters and server.
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

/** `text` is the content of lunasq/hooks/config; without a file, every script uses the defaults. */
export function parseHooksConfig(text: string | undefined): HooksConfigResult {
  if (text === undefined) return { ok: true, config: {} };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, message: `${HOOKS_CONFIG_PATH} is not valid JSON: ${String(err)}` };
  }
  const parsed = HooksConfig.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return { ok: false, message: `${HOOKS_CONFIG_PATH} invalid: ${issues.join("; ")}` };
  }
  return { ok: true, config: parsed.data };
}

export interface PlannedHook {
  script: string;
  policy: HookPolicy;
  timeoutSeconds: number;
}

/**
 * Scripts of the point in the order they run: alphabetical by file name (by code
 * units, without locale, so that a numeric prefix defines the sequence on any machine).
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

/** A script with block policy that fails stops the point: the following ones do not run. */
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

/** after_merge runs in the checkout of the project's base branch; the others, in the worktree. */
export function hookPointRunsInWorktree(point: HookPoint): boolean {
  return point !== "after_merge";
}

/**
 * Whether a failure with block policy sends the task to needs_human. after_merge arrives with the task already
 * finished and on_failure with the Run already failed: there the failure is only recorded.
 */
export function hookPointEscalates(point: HookPoint): boolean {
  return point !== "after_merge" && point !== "on_failure";
}
