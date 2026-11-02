// Scheduler configuration (docs/design.md §Scheduler, ADR 0014): concurrency limits
// global, per phase and per agent kind, and the score weights. The per-project limit lives in
// ProjectLimits.concurrency.
import { z } from "zod";
import { AgentKind, Phase } from "./enums.ts";

export const DEFAULT_GLOBAL_CONCURRENCY = 5;

const positiveInt = z.int().min(1);

/** Phases the scheduler schedules: delivery runs inside the verifier Run (ADR 0007). */
export const SchedulablePhase = Phase.exclude(["deliver"]);
export type SchedulablePhase = z.infer<typeof SchedulablePhase>;

export const SchedulerConfig = z.strictObject({
  // Live agents in total.
  globalConcurrency: positiveInt.default(DEFAULT_GLOBAL_CONCURRENCY),
  phaseConcurrency: z.partialRecord(SchedulablePhase, positiveInt).default(() => ({})),
  agentKindConcurrency: z.partialRecord(AgentKind, positiveInt).default(() => ({})),
  // In the same units as the priority: points per hour in ready.
  agingPointsPerHour: z.number().min(0).default(10),
  // Points for each non-terminal task that the task blocks, directly or transitively.
  boostPerDescendant: z.number().min(0).default(25),
  // Periodic tick: picks up aging and the changes that do not go through the outbox. Minimum 1 s so
  // that it does not become a busy loop.
  tickIntervalMs: z.int().min(1000).default(30_000),
  // Retry backoff after a failed Run: base·2^(failures-1), with a cap (docs/design.md
  // §Signals). It counts from the last failure; the scheduler tick picks it up when it expires.
  retryBackoffMs: z.int().min(0).default(30_000),
  maxRetryBackoffMs: z
    .int()
    .min(0)
    .default(10 * 60_000),
});
export type SchedulerConfig = z.infer<typeof SchedulerConfig>;
export type SchedulerConfigInput = z.input<typeof SchedulerConfig>;
