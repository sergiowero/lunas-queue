// Delivery (docs/design.md §Delivery, ADR uw-26-entrega). A conflict when integrating the base branch, or
// the suite in red after the rebase, returns the task to in_progress without raising the iteration; the
// event tells the implementer what to fix. A PR that is already open and that GitHub marks as
// conflicting with the base also returns it (ADR pr-en-conflicto).
import { z } from "zod";

export const DELIVERY_CONFLICT = "delivery.conflict";

export const DELIVERY_OUTPUT_LIMIT = 4000;

export const DeliveryConflictReason = z.enum([
  "rebase_conflict",
  "tests_failed",
  "pr_conflict",
  "ci_failed",
]);
export type DeliveryConflictReason = z.infer<typeof DeliveryConflictReason>;

export const DeliveryConflictPayload = z.strictObject({
  // Verifier Run within which delivery ran (for PR failures, that of the last pass).
  runId: z.uuid(),
  reason: DeliveryConflictReason,
  baseBranch: z.string().min(1),
  // Files in conflict (rebase_conflict); empty if the suite or a GitHub check fails.
  files: z.array(z.string().min(1)).max(200),
  // Output of the suite (tests_failed) or CI details; null on rebase/PR conflicts.
  output: z.string().max(DELIVERY_OUTPUT_LIMIT).nullable(),
});
export type DeliveryConflictPayload = z.infer<typeof DeliveryConflictPayload>;
