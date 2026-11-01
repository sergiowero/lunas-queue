import type { Phase, RunResult, SubState, TaskState, UsageTotals } from "@lunasq/schemas";

/** Nombre de una tarea en la UI: su título y, mientras el refinamiento no lo genera, el intent. */
export function taskLabel(task: { title: string | null; intent: string }): string {
  return task.title ?? task.intent;
}

/** Agente de un Run: su tipo y, si lo hay, su modelo («claude · opus»). */
export function formatAgent(run: { agentKind: string; model?: string | null }): string {
  return run.model ? `${run.agentKind} · ${run.model}` : run.agentKind;
}

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

/** Duración legible: milisegundos, segundos o minutos. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toLocaleString("es")} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** Un timeout es un ajuste, no una medida: se muestra exacto, sin redondear a minutos. */
export function formatTimeout(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

// Quita secuencias ANSI de salidas guardadas antes de que el servidor las limpiara.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
