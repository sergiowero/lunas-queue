// Enums del dominio (docs/design.md §Modelo de dominio y §Máquina de estados).
// Son la fuente única: db los usa para sus CHECK y el resto de paquetes para validar.
import { z } from "zod";

export const TaskState = z.enum([
  "draft",
  "refined",
  "in_progress",
  "verification",
  "completed",
  "needs_human",
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

export const RunResult = z.enum(["success", "failure", "cancelled"]);
export type RunResult = z.infer<typeof RunResult>;

export const SpecApproval = z.enum(["pending", "approved", "changes_requested"]);
export type SpecApproval = z.infer<typeof SpecApproval>;

// De dónde salió la identidad de sesión de un Run (docs/design.md §Identidad de sesión por Run):
// session id nativo fijado al arrancar, el que reporta herdr en `agent_session`, o solo el nombre.
export const SessionSource = z.enum(["native", "herdr", "name"]);
export type SessionSource = z.infer<typeof SessionSource>;

export const UsageSource = z.enum(["otel", "transcript", "calculated"]);
export type UsageSource = z.infer<typeof UsageSource>;
