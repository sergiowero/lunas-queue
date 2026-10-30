import type { Phase, RunResult, SubState, TaskState, UsageTotals } from "@lunasq/schemas";

/** Orden de las columnas del tablero: el flujo de la máquina de estados. */
export const BOARD_STATES: TaskState[] = [
  "draft",
  "refined",
  "in_progress",
  "verification",
  "needs_human",
  "completed",
  "cancelled",
];

export const STATE_LABEL: Record<TaskState, string> = {
  draft: "Draft",
  refined: "Refined",
  in_progress: "In progress",
  verification: "Verification",
  needs_human: "Needs human",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const SUB_STATE_LABEL: Record<SubState, string> = {
  queued: "en cola",
  running: "corriendo",
  waiting_human: "esperando humano",
};

export const PHASE_LABEL: Record<Phase, string> = {
  refine: "Refinamiento",
  implement: "Implementación",
  verify: "Verificación",
  deliver: "Entrega",
};

export const RESULT_LABEL: Record<RunResult, string> = {
  success: "éxito",
  failure: "fallo",
  cancelled: "cancelado",
};

export function isTerminal(state: TaskState): boolean {
  return state === "completed" || state === "cancelled";
}

const dateTime = new Intl.DateTimeFormat("es", { dateStyle: "short", timeStyle: "medium" });

export function formatDate(iso: string | null): string {
  return iso ? dateTime.format(new Date(iso)) : "—";
}

const integer = new Intl.NumberFormat("es");

export function formatTokens(usage: UsageTotals): string {
  const total =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return integer.format(total);
}

export function formatCost(cost: number | null): string {
  return cost === null ? "—" : `$${cost.toFixed(2)}`;
}
