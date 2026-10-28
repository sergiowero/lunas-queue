import { describe, expect, it } from "vitest";
import {
  Actor,
  AgentKind,
  Phase,
  PrState,
  QuestionStatus,
  RiskLabel,
  RunResult,
  SpecApproval,
  SubState,
  TaskState,
  UsageSource,
} from "./index.ts";

describe("enums del dominio", () => {
  it("TaskState tiene los cinco estados más needs_human y cancelled", () => {
    expect(TaskState.options).toEqual([
      "draft",
      "refined",
      "in_progress",
      "verification",
      "completed",
      "needs_human",
      "cancelled",
    ]);
  });

  it("SubState distingue cola, agente vivo y espera humana", () => {
    expect(SubState.options).toEqual(["queued", "running", "waiting_human"]);
  });

  it("Phase cubre las cuatro fases con agente", () => {
    expect(Phase.options).toEqual(["refine", "implement", "verify", "deliver"]);
  });

  it("v1 solo soporta Claude Code como tipo de agente", () => {
    expect(AgentKind.options).toEqual(["claude"]);
  });

  it("los demás enums tienen los valores del diseño", () => {
    expect(Actor.options).toEqual(["human", "agent", "system"]);
    expect(QuestionStatus.options).toEqual(["open", "answered", "cancelled"]);
    expect(PrState.options).toEqual(["open", "merged", "closed"]);
    expect(RiskLabel.options).toEqual(["low", "medium", "high"]);
    expect(RunResult.options).toEqual(["success", "failure", "cancelled"]);
    expect(SpecApproval.options).toEqual(["pending", "approved", "changes_requested"]);
    expect(UsageSource.options).toEqual(["otel", "transcript", "calculated"]);
  });

  it("rechaza valores fuera del enum", () => {
    expect(TaskState.safeParse("new").success).toBe(false);
    expect(TaskState.parse("draft")).toBe("draft");
  });
});
