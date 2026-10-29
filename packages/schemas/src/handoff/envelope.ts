import { z } from "zod";
import { EntityId, FilePath, list, Text } from "./common.ts";

// Fases que entregan handoff. Distinto de `Phase` (enums.ts), la fase del Run en el dominio.
export const HANDOFF_PHASES = ["refinement", "implementation", "verification"] as const;
export const HandoffPhase = z.enum(HANDOFF_PHASES);
export type HandoffPhase = z.infer<typeof HandoffPhase>;

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
