// Transcript de Claude Code (JSONL) a markdown compacto para el archivo de evidencia (docs/design.md
// §Auditoría, ADR uw-24-archivo-evidencia). Claude Code agrega tipos de línea entre versiones, así
// que solo se leen los turnos de conversación y lo demás se salta. El razonamiento interno no entra:
// pesa y no es evidencia de lo que el agente hizo.

import { redactSecrets } from "./redact.ts";

export const DEFAULT_TEXT_LIMIT = 8_000;
export const DEFAULT_TOOL_INPUT_LIMIT = 400;
export const DEFAULT_TOOL_RESULT_LIMIT = 1_500;
export const DEFAULT_TRANSCRIPT_LIMIT = 120_000;

export type TranscriptOptions = {
  /** Caracteres de un bloque de texto de usuario o agente. */
  textLimit?: number;
  /** Caracteres del input de una tool. */
  toolInputLimit?: number;
  /** Caracteres del resultado de una tool: se conservan el principio y el final. */
  toolResultLimit?: number;
  /** Caracteres de todo el transcript: se conservan el principio y el final. */
  maxChars?: number;
};

type Block = { type?: string; [key: string]: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Redacta y después recorta: al revés, el recorte puede partir un secreto (el BEGIN de una llave
 * en el medio omitido) y dejar un resto que ningún patrón reconoce.
 */
const safeClip = (text: string, limit: number) => clip(redactSecrets(text), limit);

/** Conserva el principio y el final de `text`; el medio, que suele ser relleno, se omite. */
function clip(text: string, limit: number, what = "caracteres omitidos"): string {
  if (text.length <= limit) return text;
  const head = Math.ceil(limit / 2);
  const tail = Math.floor(limit / 2);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n… ${omitted} ${what} …\n${text.slice(text.length - tail)}`;
}

/** Cerca de código más larga que cualquier racha de backticks del contenido. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

const clock = (timestamp: unknown) => {
  if (typeof timestamp !== "string") return "";
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(timestamp);
  return match ? ` · ${match[1]}` : "";
};

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function toolInput(name: string, input: unknown, limit: number): string {
  if (name === "Bash" && isRecord(input) && typeof input.command === "string") {
    return safeClip(input.command, limit);
  }
  return safeClip(JSON.stringify(input ?? {}), limit);
}

function renderBlocks(
  role: "Usuario" | "Agente",
  timestamp: unknown,
  blocks: Block[],
  opts: Required<Omit<TranscriptOptions, "maxChars">>,
): string[] {
  const out: string[] = [];
  const text: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      text.push(safeClip(block.text.trim(), opts.textLimit));
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      out.push(
        `\`${block.name}\`\n${fenced(toolInput(block.name, block.input, opts.toolInputLimit))}`,
      );
    } else if (block.type === "tool_result") {
      const body = safeClip(resultText(block.content).trimEnd(), opts.toolResultLimit);
      const label = block.is_error === true ? "Resultado (error)" : "Resultado";
      out.push(`${label}\n${fenced(body)}`);
    }
  }
  const parts = text.length > 0 ? [`**${role}**${clock(timestamp)}\n\n${text.join("\n\n")}`] : [];
  // Los bloques de tool van tras el texto del mismo turno; sin texto, el turno no abre con rol.
  if (text.length === 0 && out.length > 0) parts.push(`**${role}**${clock(timestamp)}`);
  return [...parts, ...out];
}

export function transcriptToMarkdown(jsonl: string, options: TranscriptOptions = {}): string {
  const opts = {
    textLimit: options.textLimit ?? DEFAULT_TEXT_LIMIT,
    toolInputLimit: options.toolInputLimit ?? DEFAULT_TOOL_INPUT_LIMIT,
    toolResultLimit: options.toolResultLimit ?? DEFAULT_TOOL_RESULT_LIMIT,
  };
  const maxChars = options.maxChars ?? DEFAULT_TRANSCRIPT_LIMIT;

  const entries: string[] = [];
  let unreadable = 0;
  for (const raw of jsonl.split("\n")) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      unreadable += 1;
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.message) || parsed.isMeta === true) continue;
    const role = parsed.type === "user" ? "Usuario" : parsed.type === "assistant" ? "Agente" : null;
    if (!role) continue;
    const { content } = parsed.message;
    const blocks: Block[] =
      typeof content === "string"
        ? [{ type: "text", text: content }]
        : Array.isArray(content)
          ? content.filter(isRecord)
          : [];
    entries.push(...renderBlocks(role, parsed.timestamp, blocks, opts));
  }
  if (unreadable > 0) entries.push(`_${unreadable} líneas ilegibles del transcript._`);
  return clip(entries.join("\n\n"), maxChars, "caracteres omitidos del transcript");
}
