// Entrega (docs/design.md §Entrega, ADR uw-26-entrega). Un conflicto al integrar la rama base, o
// la suite en rojo después del rebase, regresa la tarea a in_progress sin subir la iteración; el
// evento deja al implementador qué arreglar. También la regresa un PR ya abierto que GitHub marca
// en conflicto con la base (ADR pr-en-conflicto).
import { z } from "zod";

export const DELIVERY_CONFLICT = "delivery.conflict";

export const DELIVERY_OUTPUT_LIMIT = 4000;

export const DeliveryConflictReason = z.enum(["rebase_conflict", "tests_failed", "pr_conflict"]);
export type DeliveryConflictReason = z.infer<typeof DeliveryConflictReason>;

export const DeliveryConflictPayload = z.strictObject({
  // Run del verificador dentro del cual corrió la entrega (en pr_conflict, el del último pass).
  runId: z.uuid(),
  reason: DeliveryConflictReason,
  baseBranch: z.string().min(1),
  // Archivos con conflicto (rebase_conflict); vacío si falló la suite o en pr_conflict, donde
  // GitHub no los informa.
  files: z.array(z.string().min(1)).max(200),
  // Cola de la salida de la suite (tests_failed); null en un conflicto de rebase.
  output: z.string().max(DELIVERY_OUTPUT_LIMIT).nullable(),
});
export type DeliveryConflictPayload = z.infer<typeof DeliveryConflictPayload>;
