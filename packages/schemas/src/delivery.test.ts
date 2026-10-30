import { describe, expect, it } from "vitest";
import { DELIVERY_CONFLICT, DeliveryConflictPayload } from "./delivery.ts";

describe("delivery.conflict", () => {
  const runId = "0b7f1f52-6c8a-4a58-9a4b-3f6c1d1f2a10";

  it("guarda la rama base, el motivo y los archivos en conflicto", () => {
    const payload = {
      runId,
      reason: "rebase_conflict",
      baseBranch: "main",
      files: ["src/a.ts"],
      output: null,
    };
    expect(DELIVERY_CONFLICT).toBe("delivery.conflict");
    expect(DeliveryConflictPayload.parse(payload)).toEqual(payload);
  });

  it("la suite en rojo tras el rebase lleva la cola de la salida", () => {
    const payload = {
      runId,
      reason: "tests_failed",
      baseBranch: "main",
      files: [],
      output: "1 failed",
    };
    expect(DeliveryConflictPayload.parse(payload)).toEqual(payload);
  });

  it("rechaza motivos desconocidos, runs inválidos y campos extra", () => {
    const ok = { runId, reason: "rebase_conflict", baseBranch: "main", files: [], output: null };
    expect(() => DeliveryConflictPayload.parse({ ...ok, reason: "otro" })).toThrow();
    expect(() => DeliveryConflictPayload.parse({ ...ok, runId: "r1" })).toThrow();
    expect(() => DeliveryConflictPayload.parse({ ...ok, extra: 1 })).toThrow();
  });
});
