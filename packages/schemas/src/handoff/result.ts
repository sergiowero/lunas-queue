// Handoff of submit_result (ADR 0007): the task ends without code, with a Result instead of
// a spec or a diff. It is not part of HandoffV1: it does not go through verification nor is it saved as a
// phase handoff, so it has its own envelope and its own text limit.
import { z } from "zod";
import { ResultKind } from "../enums.ts";
import { TaskTitle } from "../task.ts";
import { EntityId } from "./common.ts";
import { type HandoffError, ROOT_PATH, toHandoffErrors } from "./errors.ts";

/** Text of the Result: Markdown of up to 20,000 characters. */
export const RESULT_MAX_CHARS = 20_000;

export const ResultHandoff = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: EntityId,
  runId: EntityId,
  // Phase of the Run that delivers it: accepted in refinement and implementation.
  phase: z.enum(["refinement", "implementation"]),
  summary: z.string().min(1).max(500),
  // Only saved if the task has no title yet (first refinement).
  title: TaskTitle,
  resultKind: ResultKind,
  result: z.string().trim().min(1).max(RESULT_MAX_CHARS),
});
export type ResultHandoff = z.infer<typeof ResultHandoff>;

export type ParseResultHandoffResult =
  | { success: true; data: ResultHandoff }
  | { success: false; errors: HandoffError[] };

export function parseResultHandoff(input: unknown): ParseResultHandoffResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      success: false,
      errors: [{ path: ROOT_PATH, message: "the handoff must be a JSON object" }],
    };
  }
  const result = ResultHandoff.safeParse(input);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, errors: toHandoffErrors(result.error) };
}
