// Spike UW-00/b: levanta el servidor de spikes/mcp-sdk y registra cada request con su run token.
import { appendFileSync } from "node:fs";
import { startServer } from "../mcp-sdk/server.ts";

const port = Number(process.env.PORT ?? 4518);
const log = process.env.SEEN_LOG ?? "seen.ndjson";
const server = startServer(port);
let reported = 0;
setInterval(() => {
  for (const s of server.seen.slice(reported)) appendFileSync(log, `${JSON.stringify(s)}\n`);
  reported = server.seen.length;
}, 200);
console.log(`MCP en http://127.0.0.1:${port}/mcp, log en ${log}`);
