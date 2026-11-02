// Read-only views consumed by the front end (ADR uw-21-front-end): Runs, Event log,
// usage, evidence and the global queue. They are derived from the tables; none is written through the API.
import { z } from "zod";
import { Actor, AgentKind, Phase, RunResult, SessionSource } from "./enums.ts";
import { Task } from "./task.ts";

/** A Run as the UI sees it: without the run token, which only lives in the pane's environment. */
export const RunView = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  phase: Phase,
  agentKind: AgentKind,
  model: z.string().nullable(),
  iteration: z.int().min(0),
  herdrWorkspace: z.string().nullable(),
  herdrPane: z.string().nullable(),
  herdrName: z.string().nullable(),
  agentSession: z.string().nullable(),
  agentSessionSource: SessionSource.nullable(),
  startedAt: z.date(),
  endedAt: z.date().nullable(),
  result: RunResult.nullable(),
  failureReason: z.string().nullable(),
  handoff: z.unknown(),
});
export type RunView = z.infer<typeof RunView>;

export const EventView = z.strictObject({
  id: z.int().min(1),
  taskId: z.uuid(),
  type: z.string(),
  actor: Actor,
  payload: z.unknown(),
  createdAt: z.date(),
});
export type EventView = z.infer<typeof EventView>;

const Tokens = z.int().min(0);

/** Sum of UsageRecords; costUsd is null while no record carries a cost. */
export const UsageTotals = z.strictObject({
  inputTokens: Tokens,
  outputTokens: Tokens,
  cacheReadTokens: Tokens,
  cacheWriteTokens: Tokens,
  costUsd: z.number().min(0).nullable(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

export const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
};

/** Phase for the breakdown: rework is the implementation Runs after the first rejection. */
export const UsagePhase = z.enum(["refine", "implement", "rework", "verify", "deliver"]);
export type UsagePhase = z.infer<typeof UsagePhase>;

/**
 * Task.usage (read-only, ADR uw-20-usage-collector): total and breakdown by Run, phase, agent,
 * model and verification reviewer. It only carries the groups with records.
 */
export const TaskUsage = z.strictObject({
  total: UsageTotals,
  byRun: z.array(z.strictObject({ runId: z.uuid(), phase: Phase, usage: UsageTotals })),
  byPhase: z.array(z.strictObject({ phase: UsagePhase, usage: UsageTotals })),
  byAgent: z.array(z.strictObject({ agentKind: AgentKind, usage: UsageTotals })),
  byModel: z.array(z.strictObject({ model: z.string(), usage: UsageTotals })),
  byReviewer: z.array(z.strictObject({ reviewer: z.string(), usage: UsageTotals })),
});
export type TaskUsage = z.infer<typeof TaskUsage>;

/**
 * Evidence file `lunasq/tasks/{id}.md` (written by the evidence service): from the worktree while it exists; if
 * it was already cleaned up, from the task branch and, after the merge, from the base branch. `path` is the path on
 * disk or `<ref>:<path>` in git.
 */
export const EvidenceSource = z.enum(["worktree", "branch", "base"]);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

export const TaskEvidence = z.strictObject({
  source: EvidenceSource,
  path: z.string().min(1),
  markdown: z.string(),
});
export type TaskEvidence = z.infer<typeof TaskEvidence>;

const queueBase = { task: Task, usage: UsageTotals };

/**
 * A live task in the global queue. The ones in the ready set carry the scheduler score and go first,
 * in their order; the others (running, waiting for dependencies or for the human) have no score.
 */
export const QueueEntry = z.discriminatedUnion("ready", [
  z.strictObject({
    ...queueBase,
    ready: z.literal(true),
    score: z.number(),
    effectivePriority: z.int().min(0),
  }),
  z.strictObject({
    ...queueBase,
    ready: z.literal(false),
    score: z.null(),
    effectivePriority: z.null(),
  }),
]);
export type QueueEntry = z.infer<typeof QueueEntry>;

export const QueueQuery = z.strictObject({ projectId: z.uuid().optional() });
export type QueueQuery = z.infer<typeof QueueQuery>;
