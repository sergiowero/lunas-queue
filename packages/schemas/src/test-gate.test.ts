import { describe, expect, it } from "vitest";
import { TEST_GATE_OUTPUT_LIMIT, TestGateExecutedPayload, TestGateTrigger } from "./test-gate.ts";

describe("test_gate.executed", () => {
  const executed = {
    runId: "run-1",
    trigger: "submit_for_verification",
    command: "pnpm test",
    headSha: "a".repeat(40),
    exitCode: 1,
    timedOut: false,
    durationMs: 1200,
    passed: false,
    output: "1 failed\n",
    error: null,
  };

  it("stores command, tested commit, result and output", () => {
    expect(TestGateExecutedPayload.parse(executed)).toEqual(executed);
    expect(() =>
      TestGateExecutedPayload.parse({
        ...executed,
        output: "x".repeat(TEST_GATE_OUTPUT_LIMIT + 1),
      }),
    ).toThrow();
    expect(() => TestGateExecutedPayload.parse({ ...executed, headSha: "HEAD" })).toThrow();
    // Repos with the SHA-256 object format.
    const sha256 = "b".repeat(64);
    expect(TestGateExecutedPayload.parse({ ...executed, headSha: sha256 }).headSha).toBe(sha256);
  });

  it("without a command or without an execution there is no exit code, and the gate does not pass", () => {
    const skipped = {
      ...executed,
      command: null,
      headSha: null,
      exitCode: null,
      durationMs: 0,
      output: "",
      error: "the project has no test command configured",
    };
    expect(TestGateExecutedPayload.parse(skipped)).toEqual(skipped);
    expect(() => TestGateExecutedPayload.parse({ ...skipped, passed: true })).toThrow();
  });

  it("passes only with exit 0, without timeout and without error", () => {
    const green = { ...executed, exitCode: 0, passed: true };
    expect(TestGateExecutedPayload.parse(green).passed).toBe(true);
    expect(() => TestGateExecutedPayload.parse({ ...green, exitCode: 1 })).toThrow();
    expect(() => TestGateExecutedPayload.parse({ ...green, timedOut: true })).toThrow();
  });

  it("fires on submit_for_verification, before a pass and on delivery", () => {
    expect(TestGateTrigger.options).toEqual([
      "submit_for_verification",
      "verdict_pass",
      "delivery",
    ]);
  });
});
