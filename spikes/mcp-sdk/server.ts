// MCP v2 server mounted on Hono (Streamable HTTP, stateless). spikes/run-token reuses it.
import { serve } from "@hono/node-server";
import { createMcpHonoApp, localhostHostValidation } from "@modelcontextprotocol/hono";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

export const TOKEN_HEADER = "x-lunasq-run-token";

export interface SeenRequest {
  method: string;
  rpc: string | undefined;
  token: string | undefined;
  authorization: string | undefined;
}

export function startServer(port: number) {
  const seen: SeenRequest[] = [];
  const app = createMcpHonoApp();
  app.use("*", localhostHostValidation());
  app.all("/mcp", async (c) => {
    const token = c.req.header(TOKEN_HEADER);
    const body = c.get("parsedBody") as { method?: string } | undefined;
    seen.push({ method: c.req.method, rpc: body?.method, token, authorization: c.req.header("authorization") });

    const server = new McpServer({ name: "lunasq-spike", version: "0.0.0" });
    server.registerTool(
      "echo",
      { description: "Returns the received text", inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: "text", text }] }),
    );
    server.registerTool(
      "whoami",
      { description: "Returns the run token the call arrived with" },
      async () => ({ content: [{ type: "text", text: `run token: ${token ?? "<ninguno>"}` }] }),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, { parsedBody: c.get("parsedBody") });
  });
  const http = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  return { seen, close: () => new Promise<void>((r) => http.close(() => r())) };
}
