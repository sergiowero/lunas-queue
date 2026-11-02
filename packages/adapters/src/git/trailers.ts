// Git trailers of a commit message (docs/design.md §Code traceability). Shared by
// RealGit and FakeGit so both produce the same message.

const TRAILER_LINE = /^([A-Za-z][\w-]*):[ \t]+\S/;

/**
 * Adds `trailers` at the end of the message, in the trailer block if there is one and otherwise in its own
 * paragraph (with `git commit --trailer`, a subject with `: ` is taken as a trailer block and
 * they end up glued). A key the message already carries is not repeated, even if the value differs:
 * repeating the delivery does not duplicate trailers.
 */
export function withTrailers(message: string, trailers: Record<string, string>): string {
  const body = message.replace(/\s+$/, "");
  const lines = body.split("\n");
  // Final paragraph: the lines after the last blank line.
  const blank = lines.lastIndexOf("");
  const last = lines.slice(blank + 1);
  const inTrailerBlock = blank > 0 && last.every((line) => TRAILER_LINE.test(line));
  const present = new Set(
    (inTrailerBlock ? last : []).map((line) => TRAILER_LINE.exec(line)?.[1]?.toLowerCase()),
  );
  const added = Object.entries(trailers)
    .filter(([key]) => !present.has(key.toLowerCase()))
    .map(([key, value]) => `${key}: ${value}`);
  if (added.length === 0) return message;
  return `${body}${inTrailerBlock ? "\n" : "\n\n"}${added.join("\n")}\n`;
}
