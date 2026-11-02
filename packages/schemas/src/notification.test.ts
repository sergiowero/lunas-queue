import { describe, expect, it } from "vitest";
import { Notification, NotificationKind } from "./index.ts";

const valid = {
  id: "question:q-1",
  kind: "question_open",
  taskId: "t-1",
  runId: "r-1",
  title: "Pregunta abierta en t-1",
  body: "El agente espera una respuesta desde hace 1 minuto",
  createdAt: "2026-10-29T12:00:00.000Z",
};

describe("Notification", () => {
  it("covers the four escalation points of the design and the exhausted retries", () => {
    expect(NotificationKind.options).toEqual([
      "question_open",
      "agent_blocked",
      "phase_timeout",
      "usage_limit",
      "verification_exhausted",
      "retries_exhausted",
    ]);
  });

  it("accepts a valid notification, with and without runId", () => {
    expect(Notification.parse(valid)).toEqual(valid);
    const { runId: _, ...sinRun } = valid;
    expect(Notification.parse(sinRun)).toEqual(sinRun);
  });

  it("accepts prefixed ids and colon separators", () => {
    expect(Notification.safeParse({ ...valid, id: "blocked:r-1:2" }).success).toBe(true);
  });

  it.each([
    ["empty id", { id: "" }],
    ["id with spaces", { id: "question q-1" }],
    ["unknown kind", { kind: "chat" }],
    ["empty title", { title: "" }],
    ["date that is not ISO", { createdAt: "yesterday" }],
    ["invalid taskId", { taskId: "t 1" }],
  ])("rejects %s", (_, patch) => {
    expect(Notification.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(Notification.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});
