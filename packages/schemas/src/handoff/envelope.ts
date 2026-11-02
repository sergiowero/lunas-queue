import { z } from "zod";
import { EntityId, FilePath, list, Text } from "./common.ts";

// Phases that deliver a handoff. Different from `Phase` (enums.ts), the Run's phase in the domain.
export const HANDOFF_PHASES = ["refinement", "implementation", "verification"] as const;
export const HandoffPhase = z.enum(HANDOFF_PHASES);
export type HandoffPhase = z.infer<typeof HandoffPhase>;

// A failure leaves no handoff: it is declared with report_failure.
export const HandoffResult = z.enum(["completed", "partial"]);

export const Decision = z.strictObject({
  decision: Text,
  rationale: Text.optional(),
  discarded: list(Text, 20).optional(),
});

// Envelope common to all phases; each phase adds `phase` and its `body`.
export const envelopeShape = {
  schemaVersion: z.literal(1),
  taskId: EntityId,
  runId: EntityId,
  result: HandoffResult,
  summary: z.string().min(1).max(500),
  relevantFiles: list(FilePath),
  decisions: list(Decision, 50),
  knownRisks: list(Text, 50),
};
