// Spike UW-00/d: se suscribe a events.subscribe por el socket Unix (NDJSON) y vuelca cada línea.
// Uso: node subscribe.ts <socket> <salida.ndjson> [subs-json] [--slow=<ms>]
// subs-json: suscripciones extra, p. ej. [{"type":"pane.agent_status_changed","pane_id":"w2:p1"}]
// --slow=<ms> deja de leer ese tiempo para provocar backpressure
import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";

const [socketPath, out = "outputs/events.ndjson", extra] = process.argv.slice(2);
const slowArg = process.argv.find((a) => a.startsWith("--slow="));
const pauseMs = slowArg ? Number(slowArg.slice("--slow=".length)) : 0;
const types = [
  "workspace.created", "workspace.closed", "worktree.created", "worktree.opened", "worktree.removed",
  "pane.created", "pane.closed", "pane.exited", "pane.agent_detected", "pane.updated",
].map((type) => ({ type }) as Record<string, unknown>);
if (extra && extra.startsWith("[")) types.push(...(JSON.parse(extra) as Record<string, unknown>[]));
const sock = createConnection(socketPath!);
sock.on("connect", () => {
  const req = { id: "sub-1", method: "events.subscribe", params: { subscriptions: types } };
  sock.write(`${JSON.stringify(req)}\n`);
  if (pauseMs) {
    sock.pause();
    setTimeout(() => sock.resume(), pauseMs);
  }
});
let buf = "";
sock.on("data", (chunk) => {
  buf += chunk.toString();
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), line: JSON.parse(line) })}\n`);
  }
});
sock.on("error", (err) => appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), socketError: String(err) })}\n`));
sock.on("close", () => {
  appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), closed: true })}\n`);
  process.exit(0);
});
