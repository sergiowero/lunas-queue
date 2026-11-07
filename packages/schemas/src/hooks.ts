// Phase hooks (docs/design.md §Phase hooks, ADR uw-10-hooks). The scripts live in
// lunasq/hooks/<point>/ of the project repo and their timeout and policy in lunasq/hooks/config
// (JSON); LunasQ always reads them from the base branch.
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

/** `block` stops the transition and sends the task to needs_human; `warn` is only recorded. */
export const HookPolicy = z.enum(["block", "warn"]);
export type HookPolicy = z.infer<typeof HookPolicy>;

// setTimeout treats more than 2^31-1 ms as 1 ms; a week is well below that.
export const MAX_HOOK_TIMEOUT_SECONDS = 7 * 24 * 3600;

/** A file name inside the point directory, without paths. */
export const HookScriptName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\0]+$/, "the script name cannot contain /")
  .refine((name) => name !== "." && name !== "..", "invalid script name");

export const HookSettings = z.strictObject({
  timeoutSeconds: z.int().min(1).max(MAX_HOOK_TIMEOUT_SECONDS).optional(),
  policy: HookPolicy.optional(),
});
export type HookSettings = z.infer<typeof HookSettings>;

/** Content of lunasq/hooks/config: per point, the settings of each script that does not use the defaults. */
export const HooksConfig = z.partialRecord(HookPoint, z.record(HookScriptName, HookSettings));
export type HooksConfig = z.infer<typeof HooksConfig>;

export const HOOK_EXECUTED = "hook.executed";
export const HOOK_POINT_COMPLETED = "hook.point_completed";

/** How much of a hook's output goes into its event: the end, which is where the error is. */
export const HOOK_OUTPUT_LIMIT = 16 * 1024;

const commitSha = z.string().regex(/^[0-9a-f]{40}$/, "sha de commit");

export const HookExecutedPayload = z.strictObject({
  point: HookPoint,
  script: HookScriptName,
  // Commit of the base branch from which the script was read.
  baseRef: commitSha,
  runId: z.string().min(1).nullable(),
  policy: HookPolicy,
  timeoutSeconds: z.int().min(1),
  exitCode: z.int(),
  timedOut: z.boolean(),
  durationMs: z.int().min(0),
  passed: z.boolean(),
  // stdout and stderr together, trimmed at the end.
  output: z.string().max(HOOK_OUTPUT_LIMIT),
});
export type HookExecutedPayload = z.infer<typeof HookExecutedPayload>;

export const HookPointOutcome = z.enum(["passed", "warned", "blocked"]);
export type HookPointOutcome = z.infer<typeof HookPointOutcome>;

export const HookPointCompletedPayload = z.strictObject({
  point: HookPoint,
  // null if the base branch could not be read.
  baseRef: commitSha.nullable(),
  runId: z.string().min(1).nullable(),
  outcome: HookPointOutcome,
  // Script with block policy that failed, if any.
  failedScript: HookScriptName.nullable(),
  // Failure before running scripts: fetch of the base or invalid config.
  error: z.string().min(1).max(2000).nullable(),
  // Commit with the changes the hooks left, with the task trailers.
  commit: commitSha.nullable(),
  // The hooks left changes but the worktree already had uncommitted changes: it was not committed.
  commitSkipped: z.boolean(),
});
export type HookPointCompletedPayload = z.infer<typeof HookPointCompletedPayload>;

/** A base-branch hook as the view sees it: script, effective settings and content. */
export const HookView = z.strictObject({
  script: HookScriptName,
  policy: HookPolicy,
  timeoutSeconds: z.int().min(1),
  content: z.string(),
});
export type HookView = z.infer<typeof HookView>;

/** The hooks of a project in `lunasq/hooks/` of the base branch, per point and in execution order. */
export const ProjectHooksView = z.strictObject({
  baseRef: commitSha,
  // Error of lunasq/hooks/config; with it, the displayed settings are the defaults.
  configError: z.string().nullable(),
  points: z.array(z.strictObject({ point: HookPoint, hooks: z.array(HookView) })),
});
export type ProjectHooksView = z.infer<typeof ProjectHooksView>;

/** A hook execution (hook.executed event) with the task in which it ran. */
export const HookExecutionView = z.strictObject({
  eventId: z.int().min(1),
  taskId: z.uuid(),
  taskGoal: z.string(),
  taskTitle: z.string().nullable(),
  at: z.date(),
  ...HookExecutedPayload.shape,
});
export type HookExecutionView = z.infer<typeof HookExecutionView>;

export const DEFAULT_HOOK_EXECUTIONS_PER_HOOK = 10;

/** `limit`: at most how many tasks (the most recent ones) per point and script. */
export const HookExecutionsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_HOOK_EXECUTIONS_PER_HOOK),
});
export type HookExecutionsQuery = z.infer<typeof HookExecutionsQuery>;
