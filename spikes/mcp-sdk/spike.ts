// Spike UW-00/a: servidor MCP v2 en Hono + cliente Streamable HTTP.
import { strict as assert } from "node:assert";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer, TOKEN_HEADER } from "./server.ts";

const port = 4517;
const server = startServer(port);
const client = new Client({ name: "spike-client", version: "0.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
  requestInit: { headers: { [TOKEN_HEADER]: "tok-123" } },
});
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
console.log("echo inputSchema:", JSON.stringify(tools.find((t) => t.name === "echo")?.inputSchema));

const echo = await client.callTool({ name: "echo", arguments: { text: "hola" } });
assert.deepEqual(echo.content, [{ type: "text", text: "hola" }]);
console.log("callTool echo: ok");

const bad = await client.callTool({ name: "echo", arguments: { text: 42 } });
assert.equal(bad.isError, true);
console.log("input inválido -> isError:", JSON.stringify(bad.content).slice(0, 120));

const who = await client.callTool({ name: "whoami", arguments: {} });
console.log("whoami:", JSON.stringify(who.content));

await client.close();
await server.close();
console.log("requests vistas:", server.seen.map((s) => `${s.method} ${s.rpc ?? "-"} token=${s.token}`).join(" | "));
assert.ok(server.seen.every((s) => s.token === "tok-123"));
