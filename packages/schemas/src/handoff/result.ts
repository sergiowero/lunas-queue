// Handoff de submit_result (ADR 0007): la tarea termina sin código, con un Resultado en vez de
// una spec o un diff. No forma parte de HandoffV1: no pasa por verificación ni se guarda como
// handoff de fase, así que tiene su propio sobre y su propio límite de texto.
import { z } from "zod";
import { ResultKind } from "../enums.ts";
import { TaskTitle } from "../task.ts";
import { EntityId } from "./common.ts";
import { type HandoffError, ROOT_PATH, toHandoffErrors } from "./errors.ts";

/** Texto del Resultado: Markdown de hasta 20 000 caracteres. */
export const RESULT_MAX_CHARS = 20_000;

export const ResultHandoff = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: EntityId,
  runId: EntityId,
  // Fase del Run que lo entrega: se acepta en refinamiento e implementación.
  phase: z.enum(["refinement", "implementation"]),
  summary: z.string().min(1).max(500),
  // Solo se guarda si la tarea aún no tiene título (primer refinamiento).
  title: TaskTitle,
  resultKind: ResultKind,
  result: z.string().trim().min(1).max(RESULT_MAX_CHARS),
});
export type ResultHandoff = z.infer<typeof ResultHandoff>;

export type ParseResultHandoffResult =
  | { success: true; data: ResultHandoff }
  | { success: false; errors: HandoffError[] };

const spanish = z.locales.es().localeError;

export function parseResultHandoff(input: unknown): ParseResultHandoffResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      success: false,
      errors: [{ path: ROOT_PATH, message: "el handoff debe ser un objeto JSON" }],
    };
  }
  const result = ResultHandoff.safeParse(input, { error: spanish });
  return result.success
    ? { success: true, data: result.data }
    : { success: false, errors: toHandoffErrors(result.error) };
}
