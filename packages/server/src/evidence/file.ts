// Archivo `lunasq/tasks/{id}.md`: un encabezado y una sección por Run entre marcadores. Reescribir
// la sección de un Run la reemplaza en su lugar, así cerrar un Run dos veces (reintentos,
// reconciliación) deja el mismo archivo.
import { redactSecrets } from "./redact.ts";

/** Cualquier sección de Run: el id es lo que se captura. */
const SECTION = /<!-- lunasq:run:start (\S+) -->\n[\s\S]*?\n<!-- lunasq:run:end \1 -->\n/g;

export function evidenceHeader(input: { taskId: string; intent: string }): string {
  const intent = redactSecrets(input.intent)
    .replaceAll("<!-- lunasq:", "<!-- lunasq-escapado:")
    .trim()
    .replace(/\s*\n\s*/g, " ");
  return [
    `# Evidencia de la tarea ${input.taskId}`,
    "",
    `> ${intent}`,
    "",
    "Una sección por Run, escrita por LunasQ al cerrarlo. No se edita a mano: se reescribe.",
    "",
    "",
  ].join("\n");
}

/**
 * Inserta o reemplaza la sección de `runId` en `current` (null si el archivo no existe). El
 * encabezado se regenera y lo que no sea una sección de Run se descarta.
 */
export function upsertRunSection(
  current: string | null,
  header: string,
  runId: string,
  section: string,
): string {
  const sections = new Map<string, string>();
  for (const match of (current ?? "").matchAll(SECTION)) {
    const [text, id] = match;
    if (id !== undefined) sections.set(id, text);
  }
  // Map conserva la posición de una clave existente al reasignarla.
  sections.set(runId, section.endsWith("\n") ? section : `${section}\n`);
  return header + [...sections.values()].join("\n");
}
