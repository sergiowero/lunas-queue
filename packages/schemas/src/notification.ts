// Notifications to the human (docs/design.md §Signals and §Human-in-the-loop): the four
// escalation situations, plus exhausted retries. The id is deterministic and is the deduplication key
// in every channel (herdr toast and SSE to the UI).
import { z } from "zod";
import { EntityId, ShortText, Text } from "./handoff/common.ts";

export const NotificationKind = z.enum([
  "question_open",
  "agent_blocked",
  "phase_timeout",
  "usage_limit",
  "verification_exhausted",
  // Run failed after exhausting the retries of the phase (ADR uw-17-reconciliacion).
  "retries_exhausted",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const NotificationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/, {
  error:
    "invalid notification id: 1 to 128 alphanumeric characters, hyphens, underscores or colons expected",
});

export const Notification = z.strictObject({
  id: NotificationId,
  kind: NotificationKind,
  taskId: EntityId,
  runId: EntityId.optional(),
  title: ShortText,
  body: Text,
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof Notification>;
