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
  it("reintentos agotados → retries_exhausted, con id por evento", () => {
    expect(escalationNotification(12, escalated("retries_exhausted"))).toMatchObject({
      id: `retries:${TASK}:42`,
      kind: "retries_exhausted",
      taskId: TASK,
      title: "Reintentos agotados en #12",
      createdAt: "2026-10-29T12:00:00.000Z",
    });
  });

  it("loop de verificación agotado → verification_exhausted", () => {
    expect(
      escalationNotification(12, escalated("iterations_exhausted", "verdict_rework")),
    ).toMatchObject({
      id: `iterations:${TASK}:42`,
      kind: "verification_exhausted",
      title: "Loop de verificación agotado en #12",
    });
  });

  it.each([
    ["phase_timeout: ya la notificó el watcher", escalated("phase_timeout", "escalate")],
    ["usage_limit: ya la notificó el watcher", escalated("usage_limit", "escalate")],
    ["otra transición", message({ command: "dispatch", from: {}, to: {} })],
    ["otro topic", message({}, "task.pr_opened")],
    ["payload inválido", message({ command: 1 })],
  ])("%s → nada", (_, msg) => {
    expect(escalationNotification(12, msg)).toBeNull();
  });
});
