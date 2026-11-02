import { describe, expect, it } from "vitest";
import {
  EscalationReason,
  TASK_TRANSITIONED,
  TaskCommand,
  TaskTransitionedEvent,
  TaskTransitionedPayload,
} from "./index.ts";

const payload = {
  command: "verdict_rework",
  from: { state: "verification", subState: "running" },
  to: { state: "in_progress", subState: "queued" },
  verificationIteration: 1,
};

describe("task.transitioned event", () => {
  it("TaskCommand lists the state and sub-state commands", () => {
    expect(TaskCommand.options).toEqual([
      "submit_spec",
      "request_changes",
      "approve",
      "submit_for_verification",
      "submit_result",
      "verdict_rework",
      "verdict_pass",
      "delivery_conflict",
      "escalate",
      "cancel",
      "pause",
      "resume",
      "dispatch",
      "ask_human",
      "answer",
      "run_failed",
    ]);
  });

  it("EscalationReason covers the escalation points of the design", () => {
    expect(EscalationReason.options).toEqual([
      "blocked",
      "phase_timeout",
      "usage_limit",
      "retries_exhausted",
      "iterations_exhausted",
      "hook_failed",
      "dependency_pr_closed",
      "delivery_failed",
      "providers_unavailable",
    ]);
  });

  it("accepts a complete payload, with optional reason and note", () => {
    expect(TaskTransitionedPayload.parse(payload)).toEqual(payload);
    const escalated = {
      ...payload,
      command: "escalate",
      to: { state: "needs_human", subState: null },
      reason: "phase_timeout",
      note: "30 minutes in running",
    };
    expect(TaskTransitionedPayload.parse(escalated)).toEqual(escalated);
  });

  it("rejects states outside the enum, negative iterations and extra fields", () => {
    const bad = [
      { ...payload, from: { state: "new", subState: null } },
      { ...payload, to: { state: "draft", subState: "sleeping" } },
      { ...payload, verificationIteration: -1 },
      { ...payload, verificationIteration: 1.5 },
      { ...payload, command: "teleport" },
      { ...payload, reason: "boring" },
      { ...payload, extra: true },
    ];
    for (const value of bad) {
      expect(TaskTransitionedPayload.safeParse(value).success).toBe(false);
    }
  });

  it("the event fixes its type and requires an actor from the enum", () => {
    const event = { type: TASK_TRANSITIONED, actor: "agent", payload };
    expect(TaskTransitionedEvent.parse(event)).toEqual(event);
    expect(TaskTransitionedEvent.safeParse({ ...event, type: "task.created" }).success).toBe(false);
    expect(TaskTransitionedEvent.safeParse({ ...event, actor: "robot" }).success).toBe(false);
  });
});
