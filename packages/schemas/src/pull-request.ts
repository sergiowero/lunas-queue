// Events of a task's PR (ADR uw-14-adapter-github). The PR only advances from open to merged or
// closed; a new PR (another delivery after a close without merge) opens again with task.pr_opened.
import { z } from "zod";

export const TASK_PR_OPENED = "task.pr_opened";
export const TASK_PR_STATE_CHANGED = "task.pr_state_changed";

export const TaskPrOpenedPayload = z.strictObject({
  url: z.url(),
  // Previous PR of the task (closed without merge), if there was one.
  previousUrl: z.string().nullable(),
});
export type TaskPrOpenedPayload = z.infer<typeof TaskPrOpenedPayload>;

export const ClosedPrState = z.enum(["merged", "closed"]);
export type ClosedPrState = z.infer<typeof ClosedPrState>;

export const TaskPrStateChangedPayload = z.strictObject({
  url: z.url(),
  from: z.literal("open"),
  to: ClosedPrState,
  // Time of the merge or the close according to GitHub (ISO 8601); null if GitHub did not give it.
  at: z.iso.datetime().nullable(),
});
export type TaskPrStateChangedPayload = z.infer<typeof TaskPrStateChangedPayload>;
