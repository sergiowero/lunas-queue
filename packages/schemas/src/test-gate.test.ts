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

  it("guarda comando, commit probado, resultado y salida", () => {
    expect(TestGateExecutedPayload.parse(executed)).toEqual(executed);
    expect(() =>
      TestGateExecutedPayload.parse({
        ...executed,
        output: "x".repeat(TEST_GATE_OUTPUT_LIMIT + 1),
      }),
    ).toThrow();
    expect(() => TestGateExecutedPayload.parse({ ...executed, headSha: "HEAD" })).toThrow();
    // Repos con object format SHA-256.
    const sha256 = "b".repeat(64);
    expect(TestGateExecutedPayload.parse({ ...executed, headSha: sha256 }).headSha).toBe(sha256);
  });

  it("sin comando o sin ejecución no hay exit code, y el gate no pasa", () => {
    const skipped = {
      ...executed,
      command: null,
      headSha: null,
      exitCode: null,
      durationMs: 0,
      output: "",
      error: "el proyecto no tiene comando de tests configurado",
    };
    expect(TestGateExecutedPayload.parse(skipped)).toEqual(skipped);
    expect(() => TestGateExecutedPayload.parse({ ...skipped, passed: true })).toThrow();
  });

  it("pasa solo con exit 0, sin timeout y sin error", () => {
    const green = { ...executed, exitCode: 0, passed: true };
    expect(TestGateExecutedPayload.parse(green).passed).toBe(true);
    expect(() => TestGateExecutedPayload.parse({ ...green, exitCode: 1 })).toThrow();
    expect(() => TestGateExecutedPayload.parse({ ...green, timedOut: true })).toThrow();
  });

  it("dispara en submit_for_verification, antes de un pass y en la entrega", () => {
    expect(TestGateTrigger.options).toEqual([
      "submit_for_verification",
      "verdict_pass",
      "delivery",
    ]);
  });
});
