// Trailers de git de un mensaje de commit (docs/design.md §Trazabilidad del código). Lo comparten
// RealGit y FakeGit para que ambos produzcan el mismo mensaje.

const TRAILER_LINE = /^([A-Za-z][\w-]*):[ \t]+\S/;

/**
 * Agrega `trailers` al final del mensaje, en el bloque de trailers si ya hay uno y si no en un
 * párrafo propio (con `git commit --trailer`, un asunto con `: ` se toma como bloque de trailers y
 * quedan pegados). Una clave que el mensaje ya trae no se repite, aunque el valor sea distinto:
 * repetir la entrega no duplica trailers.
 */
export function withTrailers(message: string, trailers: Record<string, string>): string {
  const body = message.replace(/\s+$/, "");
  const lines = body.split("\n");
  // Párrafo final: las líneas posteriores a la última línea en blanco.
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
