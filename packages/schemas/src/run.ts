// Contract between the dispatcher, the agent pane and the LunasQ MCP (ADR 0002, docs/tech-stack.md
// §Environment variables). The token only lives in the pane's environment; the MCP file references it.
import { z } from "zod";
import { Phase } from "./enums.ts";

/** Header with which Claude Code sends the run token on each request to the LunasQ MCP. */
export const RUN_TOKEN_HEADER = "X-LunasQ-Run-Token";

/** Variables the dispatcher sets in the pane of each Run. */
export const RUN_ENV = {
  runToken: "LUNASQ_RUN_TOKEN",
  taskId: "LUNASQ_TASK_ID",
  runId: "LUNASQ_RUN_ID",
  phase: "LUNASQ_PHASE",
} as const;

/**
 * A Run closed with result failure (declared by the agent or detected by LunasQ). Appended and published
 * in the same transaction that closes it, once per Run; the on_failure hooks hang from it
 * (ADR uw-10-hooks).
 */
export const RUN_FAILED = "run.failed";

export const RunFailedPayload = z.strictObject({
  runId: z.string().min(1),
  phase: Phase,
  reason: z.string().min(1).max(2000),
});
export type RunFailedPayload = z.infer<typeof RunFailedPayload>;

/**
 * A launched Run failed because of its model (usage limit, the agent exited or stopped without the
 * end-of-phase signal) and the phase moves to the next model of its agent profile. It replaces
 * `run.failed` for that Run: a fallback is not a failure of the phase and consumes no retry.
 */
export const RUN_MODEL_FALLBACK = "run.model_fallback";

export const RunModelFallbackPayload = z.strictObject({
  runId: z.string().min(1),
  phase: Phase,
  modelIndex: z.int().min(0),
  reason: z.string().min(1).max(2000),
});
export type RunModelFallbackPayload = z.infer<typeof RunModelFallbackPayload>;

/** Why a model of an agent profile was left out of a phase dispatch. */
export const RUN_PROVIDER_ATTEMPT = "run.provider_attempt";
