import { describe, expect, it } from "vitest";
import {
  Actor,
  AgentKind,
  Phase,
  PrState,
  QuestionStatus,
  ResultKind,
  RiskLabel,
  RunResult,
  SpecApproval,
  SubState,
  TaskState,
  UsageSource,
} from "./index.ts";

describe("domain enums", () => {
  it("TaskState has the five states plus needs_human, paused and cancelled", () => {
    expect(TaskState.options).toEqual([
      "draft",
      "refined",
      "in_progress",
      "verification",
      "completed",
      "needs_human",
      "paused",
      "cancelled",
    ]);
  });

  it("SubState distinguishes queue, live agent and waiting for a human", () => {
    expect(SubState.options).toEqual(["queued", "running", "waiting_human"]);
  });

  it("Phase covers the four phases with an agent", () => {
    expect(Phase.options).toEqual(["refine", "implement", "verify", "deliver"]);
  });

  it("lists the supported agent providers", () => {
    expect(AgentKind.options).toEqual(["claude", "copilot", "codex"]);
  });

  it("the other enums have the values of the design", () => {
    expect(Actor.options).toEqual(["human", "agent", "system"]);
    expect(QuestionStatus.options).toEqual(["open", "answered", "cancelled"]);
    expect(PrState.options).toEqual(["open", "merged", "closed"]);
    expect(RiskLabel.options).toEqual(["low", "medium", "high"]);
    expect(RunResult.options).toEqual(["success", "failure", "cancelled"]);
    expect(SpecApproval.options).toEqual(["pending", "approved", "changes_requested"]);
    expect(UsageSource.options).toEqual(["otel", "transcript", "calculated"]);
  });

  it("rejects values outside the enum", () => {
    expect(TaskState.safeParse("new").success).toBe(false);
    expect(TaskState.parse("draft")).toBe("draft");
  });

  it("ResultKind distinguishes research, already implemented and not resolvable", () => {
    expect(ResultKind.options).toEqual(["research", "already_implemented", "not_resolvable"]);
  });
});
