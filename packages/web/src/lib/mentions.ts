// #N mentions in a task's goal (ADR 0015): `#` followed by digits, without a letter, digit
// or `#` stuck before nor a letter or digit stuck after. This way `a#5`, `#5x` and `#abc` are text.
export type Mention = { number: number; text: string };

const MENTION = /(?<![\p{L}\p{N}_#])#([1-9]\d*)(?![\p{L}\p{N}_])/gu;

/** Splits `text` into text chunks and mentions, in order; omits the empty chunks. */
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
