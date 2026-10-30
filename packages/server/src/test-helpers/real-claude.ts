// Arnés de las pruebas contra Claude Code real (`test:claude`, `test:skills`): sirve la app de Hono
// en un puerto local y abre `claude -p` como lo haría un pane.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

export const claudeBin = process.env.CLAUDE_BIN ?? "claude";

/** Sirve una app de Hono con node:http, sin agregar @hono/node-server. */
export function serve(fetch: (req: Request) => Response | Promise<Response>): Promise<Server> {
  const server = createServer(async (req, res) => {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
    const response = await fetch(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: body as ReadableStream | undefined,
        duplex: "half",
      } as RequestInit),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

export function runClaude(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, args, { cwd, env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`claude salió con ${code}:\n${out}`)),
    );
  });
}
