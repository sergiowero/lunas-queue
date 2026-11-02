import type { TaskState, UsageTotals } from "@lunasq/schemas";
import { currentLanguage, LOCALE } from "./i18n.ts";

/** Name of a task in the UI: its title and, until refinement generates it, the intent. */
export function taskLabel(task: { title: string | null; intent: string }): string {
  return task.title ?? task.intent;
}

/** A Run's agent: its kind and, if any, its model («claude · opus»). */
export function formatAgent(run: { agentKind: string; model?: string | null }): string {
  return run.model ? `${run.agentKind} · ${run.model}` : run.agentKind;
}

/** Order of the board columns: the state machine's flow. */
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

/** States from which the human can pause (mirror of the state machine). */
export function canPause(state: TaskState): boolean {
  return (
    state === "draft" || state === "refined" || state === "in_progress" || state === "verification"
  );
}

/** States the human returns to the flow with resume. */
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

/** Readable duration: milliseconds, seconds or minutes. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toLocaleString(locale())} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** A timeout is a setting, not a measurement: shown exactly, without rounding to minutes. */
export function formatTimeout(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

// Strips ANSI sequences from saved outputs from before the server cleaned them.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
