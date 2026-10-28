import { z } from "zod";
import { EntityId, FilePath, list, Text } from "./common.ts";

export const PHASES = ["refinement", "implementation", "verification"] as const;
export const Phase = z.enum(PHASES);
export type Phase = z.infer<typeof Phase>;

// Un fallo no deja handoff: se declara con report_failure.
export const HandoffResult = z.enum(["completed", "partial"]);

export const Decision = z.strictObject({
  decision: Text,
  rationale: Text.optional(),
  discarded: list(Text, 20).optional(),
});

// Sobre común a todas las fases; cada fase agrega `phase` y su `body`.
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
