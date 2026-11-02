import { describe, expect, it } from "vitest";
import { DELIVERY_CONFLICT, DeliveryConflictPayload } from "./delivery.ts";

describe("delivery.conflict", () => {
  const runId = "0b7f1f52-6c8a-4a58-9a4b-3f6c1d1f2a10";

  it("stores the base branch, the reason and the conflicting files", () => {
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

  it("the suite in red after the rebase carries the tail of the output", () => {
    const payload = {
      runId,
      reason: "tests_failed",
      baseBranch: "main",
      files: [],
      output: "1 failed",
    };
    expect(DeliveryConflictPayload.parse(payload)).toEqual(payload);
  });

  it("the failed PR checks include the reason and the detail", () => {
    const payload = {
      runId,
      reason: "ci_failed",
      baseBranch: "main",
      files: [],
      output: "build: https://github.com/o/r/actions/runs/1",
    };
    expect(DeliveryConflictPayload.parse(payload)).toEqual(payload);
  });

  it("rejects unknown reasons, invalid runs and extra fields", () => {
    const ok = { runId, reason: "rebase_conflict", baseBranch: "main", files: [], output: null };
    expect(() => DeliveryConflictPayload.parse({ ...ok, reason: "other" })).toThrow();
    expect(() => DeliveryConflictPayload.parse({ ...ok, runId: "r1" })).toThrow();
    expect(() => DeliveryConflictPayload.parse({ ...ok, extra: 1 })).toThrow();
  });
});
