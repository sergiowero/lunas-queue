// Domain enums (docs/design.md §Domain model and §State machine).
// They are the single source: db uses them for its CHECKs and the rest of the packages to validate.
import { z } from "zod";

export const TaskState = z.enum([
  "draft",
  "refined",
  "in_progress",
  "verification",
  "completed",
  "needs_human",
  "paused",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskState>;

export const SubState = z.enum(["queued", "running", "waiting_human"]);
export type SubState = z.infer<typeof SubState>;

export const Phase = z.enum(["refine", "implement", "verify", "deliver"]);
export type Phase = z.infer<typeof Phase>;

export const AgentKind = z.enum(["claude", "copilot"]);
export type AgentKind = z.infer<typeof AgentKind>;

export const Actor = z.enum(["human", "agent", "system"]);
export type Actor = z.infer<typeof Actor>;

export const QuestionStatus = z.enum(["open", "answered", "cancelled"]);
export type QuestionStatus = z.infer<typeof QuestionStatus>;

export const PrState = z.enum(["open", "merged", "closed"]);
export type PrState = z.infer<typeof PrState>;

export const RiskLabel = z.enum(["low", "medium", "high"]);
export type RiskLabel = z.infer<typeof RiskLabel>;

/**
 * Result type of a task without code (ADR 0007): research or synthesis, a request
 * that is already implemented in the repo or one that has no resolution.
 */
export const ResultKind = z.enum(["research", "already_implemented", "not_resolvable"]);
export type ResultKind = z.infer<typeof ResultKind>;

export const RunResult = z.enum(["success", "failure", "cancelled"]);
export type RunResult = z.infer<typeof RunResult>;

export const SpecApproval = z.enum(["pending", "approved", "changes_requested"]);
export type SpecApproval = z.infer<typeof SpecApproval>;

// Where the identity of a Run's session came from (docs/design.md §Session identity per Run):
// native session id set at startup, the one herdr reports in `agent_session`, or just the name.
export const SessionSource = z.enum(["native", "herdr", "name"]);
export type SessionSource = z.infer<typeof SessionSource>;

export const UsageSource = z.enum(["otel", "transcript", "calculated"]);
export type UsageSource = z.infer<typeof UsageSource>;
