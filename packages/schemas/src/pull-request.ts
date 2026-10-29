// Eventos del PR de una tarea (UW-14, ADR 0015). El PR solo avanza de open a merged o closed;
// un PR nuevo (otra entrega tras un cierre sin merge) vuelve a abrir con task.pr_opened.
import { z } from "zod";

export const TASK_PR_OPENED = "task.pr_opened";
export const TASK_PR_STATE_CHANGED = "task.pr_state_changed";

export const TaskPrOpenedPayload = z.strictObject({
  url: z.url(),
  // PR anterior de la tarea (cerrado sin merge), si lo había.
  previousUrl: z.string().nullable(),
});
export type TaskPrOpenedPayload = z.infer<typeof TaskPrOpenedPayload>;

export const ClosedPrState = z.enum(["merged", "closed"]);
export type ClosedPrState = z.infer<typeof ClosedPrState>;

export const TaskPrStateChangedPayload = z.strictObject({
  url: z.url(),
  from: z.literal("open"),
  to: ClosedPrState,
  // Hora del merge o del cierre según GitHub (ISO 8601); null si GitHub no la dio.
  at: z.iso.datetime().nullable(),
});
export type TaskPrStateChangedPayload = z.infer<typeof TaskPrStateChangedPayload>;
