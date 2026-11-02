import type { OutboxMessage } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { escalationNotification } from "./escalations.ts";

const TASK = "0f3c9a2e-7b41-4d2a-9e0c-5a6b7c8d9e10";

function message(payload: Record<string, unknown>, topic = "task.transitioned"): OutboxMessage {
  return {
    id: 7,
    eventId: 42,
    topic,
    taskId: TASK,
    actor: "system",
    payload: { verificationIteration: 3, ...payload },
    createdAt: "2026-10-29T12:00:00.000Z",
  };
}

const escalated = (reason: string, command = "run_failed") =>
  message({
    command,
    from: { state: "in_progress", subState: "running" },
    to: { state: "needs_human", subState: null },
    reason,
  });

describe("escalationNotification", () => {
  it("retries exhausted → retries_exhausted, with id per event", () => {
    expect(escalationNotification(12, escalated("retries_exhausted"))).toMatchObject({
      id: `retries:${TASK}:42`,
      kind: "retries_exhausted",
      taskId: TASK,
      title: "Retries exhausted in #12",
      createdAt: "2026-10-29T12:00:00.000Z",
    });
  });

  it("verification loop exhausted → verification_exhausted", () => {
    expect(
      escalationNotification(12, escalated("iterations_exhausted", "verdict_rework")),
    ).toMatchObject({
      id: `iterations:${TASK}:42`,
      kind: "verification_exhausted",
      title: "Verification loop exhausted in #12",
    });
  });

  it.each([
    ["phase_timeout: already notified by the watcher", escalated("phase_timeout", "escalate")],
    ["usage_limit: already notified by the watcher", escalated("usage_limit", "escalate")],
    ["another transition", message({ command: "dispatch", from: {}, to: {} })],
    ["another topic", message({}, "task.pr_opened")],
    ["invalid payload", message({ command: 1 })],
  ])("%s → nada", (_, msg) => {
    expect(escalationNotification(12, msg)).toBeNull();
  });
});
