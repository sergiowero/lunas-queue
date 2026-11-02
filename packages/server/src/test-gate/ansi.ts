// Strips ANSI escape sequences (colors, bold, OSC links) from a suite's output.
// Without this, the Event log stores `\u001b[2m…\u001b[22m` as is and the output cannot be read.

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
