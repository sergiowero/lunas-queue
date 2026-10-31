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
  it("cubre los cuatro puntos de escalamiento del diseño y los reintentos agotados", () => {
    expect(NotificationKind.options).toEqual([
      "question_open",
      "agent_blocked",
      "phase_timeout",
      "usage_limit",
      "verification_exhausted",
      "retries_exhausted",
    ]);
  });

  it("acepta una notificación válida, con y sin runId", () => {
    expect(Notification.parse(valid)).toEqual(valid);
    const { runId: _, ...sinRun } = valid;
    expect(Notification.parse(sinRun)).toEqual(sinRun);
  });

  it("acepta ids con prefijo y separadores de dos puntos", () => {
    expect(Notification.safeParse({ ...valid, id: "blocked:r-1:2" }).success).toBe(true);
  });

  it.each([
    ["id vacío", { id: "" }],
    ["id con espacios", { id: "question q-1" }],
    ["kind desconocido", { kind: "chat" }],
    ["título vacío", { title: "" }],
    ["fecha que no es ISO", { createdAt: "ayer" }],
    ["taskId inválido", { taskId: "t 1" }],
  ])("rechaza %s", (_, patch) => {
    expect(Notification.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it("rechaza campos desconocidos", () => {
    expect(Notification.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});
