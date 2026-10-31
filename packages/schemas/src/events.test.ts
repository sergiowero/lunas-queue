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

describe("evento task.transitioned", () => {
  it("TaskCommand enumera los comandos de estado y de sub-estado", () => {
    expect(TaskCommand.options).toEqual([
      "submit_spec",
      "request_changes",
      "approve",
      "submit_for_verification",
      "verdict_rework",
      "verdict_pass",
      "delivery_conflict",
      "escalate",
      "cancel",
      "resume",
      "dispatch",
      "ask_human",
      "answer",
      "run_failed",
    ]);
  });

  it("EscalationReason cubre los puntos de escalamiento del diseño", () => {
    expect(EscalationReason.options).toEqual([
      "blocked",
      "phase_timeout",
      "usage_limit",
      "retries_exhausted",
      "iterations_exhausted",
      "hook_failed",
      "dependency_pr_closed",
      "delivery_failed",
    ]);
  });

  it("acepta un payload completo, con razón y nota opcionales", () => {
    expect(TaskTransitionedPayload.parse(payload)).toEqual(payload);
    const escalated = {
      ...payload,
      command: "escalate",
      to: { state: "needs_human", subState: null },
      reason: "phase_timeout",
      note: "30 minutos en running",
    };
    expect(TaskTransitionedPayload.parse(escalated)).toEqual(escalated);
  });

  it("rechaza estados fuera del enum, iteraciones negativas y campos extra", () => {
    const bad = [
      { ...payload, from: { state: "new", subState: null } },
      { ...payload, to: { state: "draft", subState: "sleeping" } },
      { ...payload, verificationIteration: -1 },
      { ...payload, verificationIteration: 1.5 },
      { ...payload, command: "teleport" },
      { ...payload, reason: "aburrido" },
      { ...payload, extra: true },
    ];
    for (const value of bad) {
      expect(TaskTransitionedPayload.safeParse(value).success).toBe(false);
    }
  });

  it("el evento fija su tipo y exige actor del enum", () => {
    const event = { type: TASK_TRANSITIONED, actor: "agent", payload };
    expect(TaskTransitionedEvent.parse(event)).toEqual(event);
    expect(TaskTransitionedEvent.safeParse({ ...event, type: "task.created" }).success).toBe(false);
    expect(TaskTransitionedEvent.safeParse({ ...event, actor: "robot" }).success).toBe(false);
  });
});
