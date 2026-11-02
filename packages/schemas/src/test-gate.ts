// Test gate (docs/design.md §Engineering practices, ADR uw-11-gate-tests): LunasQ runs the
// project's test command in the worktree and stores each execution in the Event log.
import { z } from "zod";

export const TEST_GATE_EXECUTED = "test_gate.executed";

/** How much of the output goes into the event: the end, which is where the error is. */
export const TEST_GATE_OUTPUT_LIMIT = 16 * 1024;

/** When the gate runs: when verification is requested, before accepting a pass and on delivery. */
export const TestGateTrigger = z.enum(["submit_for_verification", "verdict_pass", "delivery"]);
export type TestGateTrigger = z.infer<typeof TestGateTrigger>;

export const TestGateExecutedPayload = z
  .strictObject({
    runId: z.string().min(1),
    trigger: TestGateTrigger,
    // null if the project has no test command.
    command: z.string().min(1).nullable(),
    // Commit of the worktree on which the suite ran; null if it could not be read.
    headSha: z
      .string()
      // 40 caracteres en repos SHA-1, 64 en repos SHA-256.
      .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, "sha de commit")
      .nullable(),
    // null if the suite never ran.
    exitCode: z.int().nullable(),
    timedOut: z.boolean(),
    durationMs: z.int().min(0),
    passed: z.boolean(),
    // stdout and stderr together, trimmed at the end.
    output: z.string().max(TEST_GATE_OUTPUT_LIMIT),
    // Why it did not run or the result could not be read (no command, herdr down).
    error: z.string().min(1).max(2000).nullable(),
  })
  .refine(
    (p) => p.passed === (p.exitCode === 0 && !p.timedOut && p.error === null),
    "passed only with exit 0, without timeout and without error",
  );
export type TestGateExecutedPayload = z.infer<typeof TestGateExecutedPayload>;
