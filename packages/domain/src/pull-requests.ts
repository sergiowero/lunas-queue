// Seguimiento del PR de una tarea (UW-14, ADR 0015). El poller de merges observa el PR en GitHub
// y registra el cambio en la base; el scheduler reacciona al evento (ADR 0014): un merge libera a
// los dependientes y un cierre sin merge los escala a needs_human.
import type { ClosedPrState, PrState } from "@lunasq/schemas";

/**
 * Cambio que se registra al observar `observed` con la tarea en `current`: solo open → merged o
 * closed. Un PR mergeado o cerrado no vuelve atrás; uno nuevo se registra con recordPrOpened.
 */
export function prStateChange(current: PrState | null, observed: PrState): ClosedPrState | null {
  if (current !== "open" || observed === "open") return null;
  return observed;
}

export type TrackedPr = { taskId: string; url: string };

export type ObservedPrState = { url: string; state: PrState; at: Date | null };

export interface PrTrackingStore {
  /** Tareas con PR abierto: las que el poller consulta. */
  listOpen(): TrackedPr[];
  /** Registra un PR abierto para la tarea. false si ya estaba registrado así. */
  recordPrOpened(taskId: string, url: string): boolean;
  /** Registra lo observado si es un cambio válido del PR actual de la tarea; si no, false. */
  recordPrState(taskId: string, observed: ObservedPrState): boolean;
}
