// File `lunasq/tasks/{id}.md`: a header and one section per Run between markers. Rewriting
// a Run's section replaces it in place, so closing a Run twice (retries,
// reconciliation) leaves the same file.
import { redactSecrets } from "./redact.ts";

/** Any Run section: the id is what is captured. */
const SECTION = /<!-- lunasq:run:start (\S+) -->\n[\s\S]*?\n<!-- lunasq:run:end \1 -->\n/g;

export function evidenceHeader(input: { taskId: string; intent: string }): string {
  const intent = redactSecrets(input.intent)
    .replaceAll("<!-- lunasq:", "<!-- lunasq-escapado:")
    .trim()
    .replace(/\s*\n\s*/g, " ");
  return [
    `# Evidence for task ${input.taskId}`,
    "",
    `> ${intent}`,
    "",
    "One section per Run, written by LunasQ when it closes. It is not edited by hand: it is rewritten.",
    "",
    "",
  ].join("\n");
}

/**
 * Inserts or replaces the section of `runId` in `current` (null if the file does not exist). The
 * header is regenerated and whatever is not a Run section is discarded.
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
  // Map keeps the position of an existing key when reassigned.
  sections.set(runId, section.endsWith("\n") ? section : `${section}\n`);
  return header + [...sections.values()].join("\n");
}
