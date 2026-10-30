// Menciones #N en el intent de una tarea (ADR 0015): `#` seguido de dígitos, sin una letra, dígito
// o `#` pegados antes ni una letra o dígito pegados después. Así `a#5`, `#5x` y `#abc` son texto.
export type Mention = { number: number; text: string };

const MENTION = /(?<![\p{L}\p{N}_#])#([1-9]\d*)(?![\p{L}\p{N}_])/gu;

/** Parte `text` en trozos de texto y menciones, en orden; omite los trozos vacíos. */
export function splitMentions(text: string): (string | Mention)[] {
  const parts: (string | Mention)[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const start = match.index;
    if (start > last) parts.push(text.slice(last, start));
    parts.push({ number: Number(match[1]), text: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
