import type { TaskState, UsageTotals } from "@lunasq/schemas";
import { currentLanguage, LOCALE } from "./i18n.ts";

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
  "paused",
  "completed",
  "cancelled",
];

export function isTerminal(state: TaskState): boolean {
  return state === "completed" || state === "cancelled";
}

/** Estados desde los que el humano puede pausar (espejo de la máquina de estados). */
export function canPause(state: TaskState): boolean {
  return (
    state === "draft" || state === "refined" || state === "in_progress" || state === "verification"
  );
}

/** Estados que el humano devuelve al flujo con resume. */
export function canResume(state: TaskState): boolean {
  return state === "paused" || state === "needs_human";
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

/** Locale of the effective language: dates and numbers follow it. */
function locale(): string {
  return LOCALE[currentLanguage()];
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const key = locale();
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(key, { dateStyle: "short", timeStyle: "medium" });
    dateFormats.set(key, format);
  }
  return format.format(new Date(iso));
}

function integer(value: number): string {
  const key = locale();
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(key);
    numberFormats.set(key, format);
  }
  return format.format(value);
}

export function formatTokens(usage: UsageTotals): string {
  const total =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return integer(total);
}

export function formatCost(cost: number | null): string {
  return cost === null ? "—" : `$${cost.toFixed(2)}`;
}

/** Duración legible: milisegundos, segundos o minutos. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toLocaleString(locale())} s`;
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
