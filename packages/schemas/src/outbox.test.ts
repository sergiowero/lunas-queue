import { describe, expect, it } from "vitest";
import { OutboxMessage, TASK_TRANSITIONED } from "./index.ts";

const valid = {
  id: 7,
  eventId: 12,
  topic: TASK_TRANSITIONED,
  taskId: "t-1",
  actor: "system",
  payload: { command: "dispatch" },
  createdAt: "2026-10-29T12:00:00.000Z",
};

describe("OutboxMessage", () => {
  it("acepta un mensaje válido con cualquier payload", () => {
    expect(OutboxMessage.parse(valid)).toEqual(valid);
    expect(OutboxMessage.parse({ ...valid, payload: null })).toMatchObject({ payload: null });
  });

  it("exige ids enteros positivos, topic no vacío y actor conocido", () => {
    expect(() => OutboxMessage.parse({ ...valid, id: 0 })).toThrow();
    expect(() => OutboxMessage.parse({ ...valid, eventId: 1.5 })).toThrow();
    expect(() => OutboxMessage.parse({ ...valid, topic: "" })).toThrow();
    expect(() => OutboxMessage.parse({ ...valid, actor: "robot" })).toThrow();
  });

  it("rechaza campos extra", () => {
    expect(() => OutboxMessage.parse({ ...valid, extra: true })).toThrow();
  });
});
