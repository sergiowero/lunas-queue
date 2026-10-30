// Gate de tests (docs/design.md §Prácticas de ingeniería, ADR uw-11-gate-tests): LunasQ corre el
// comando de tests del proyecto en el worktree y guarda cada ejecución en el Event log.
import { z } from "zod";

export const TEST_GATE_EXECUTED = "test_gate.executed";

/** Cuánto de la salida entra en el evento: el final, que es donde está el error. */
export const TEST_GATE_OUTPUT_LIMIT = 16 * 1024;

/** Cuándo corre el gate: al pedir verificación, antes de aceptar un pass y en la entrega (UW-26). */
export const TestGateTrigger = z.enum(["submit_for_verification", "verdict_pass", "delivery"]);
export type TestGateTrigger = z.infer<typeof TestGateTrigger>;

export const TestGateExecutedPayload = z
  .strictObject({
    runId: z.string().min(1),
    trigger: TestGateTrigger,
    // null si el proyecto no tiene comando de tests.
    command: z.string().min(1).nullable(),
    // Commit del worktree sobre el que corrió la suite; null si no se pudo leer.
    headSha: z
      .string()
      // 40 caracteres en repos SHA-1, 64 en repos SHA-256.
      .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, "sha de commit")
      .nullable(),
    // null si la suite no llegó a correr.
    exitCode: z.int().nullable(),
    timedOut: z.boolean(),
    durationMs: z.int().min(0),
    passed: z.boolean(),
    // stdout y stderr juntos, recortados al final.
    output: z.string().max(TEST_GATE_OUTPUT_LIMIT),
    // Por qué no corrió o no se pudo leer el resultado (sin comando, herdr caído).
    error: z.string().min(1).max(2000).nullable(),
  })
  .refine(
    (p) => p.passed === (p.exitCode === 0 && !p.timedOut && p.error === null),
    "passed solo con exit 0, sin timeout y sin error",
  );
export type TestGateExecutedPayload = z.infer<typeof TestGateExecutedPayload>;
