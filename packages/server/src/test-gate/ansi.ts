// Quita las secuencias de escape ANSI (colores, negritas, enlaces OSC) de la salida de una suite.
// Sin esto, el Event log guarda `\u001b[2m…\u001b[22m` tal cual y la salida no se puede leer.

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
