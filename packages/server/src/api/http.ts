// Helpers shared by the routes: body reading and common error responses.
import type { Context, MiddlewareHandler } from "hono";

interface ValidationError {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}

export function invalidInput(c: Context, error: ValidationError) {
  const issues = error.issues.map(({ path, message }) => ({ path: path.map(String), message }));
  return c.json({ error: "invalid_input", issues }, 400);
}

export async function readJson(c: Context): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

/** Like readJson, but an empty body is `{}`: for actions with an optional body. */
export async function readOptionalJson(
  c: Context,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (text.trim() === "") return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export const notFound = (c: Context) => c.json({ error: "not_found" }, 404);

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

/** Address of the peer that opened the connection; undefined outside a real server (app.request). */
function peerAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/**
 * Defense against DNS rebinding and cross-origin browser requests: the local API has no
 * authentication, so it rejects (403 forbidden_origin) any Host or Origin that is not localhost.
 * Host and Origin are controlled by the client, so it also requires the connection to come from loopback:
 * with the server bound to another interface, a remote client cannot just forge Host.
 */
export const localOriginOnly: MiddlewareHandler = async (c, next) => {
  const peer = peerAddress(c);
  if (peer !== undefined && !isLoopback(peer)) return c.json({ error: "forbidden_origin" }, 403);
  const host = c.req.header("host");
  const origin = c.req.header("origin");
  const hostname = host === undefined ? hostnameOf(c.req.url) : hostnameOf(host);
  const originHostname = origin === undefined ? "localhost" : hostnameOf(origin);
  if (
    hostname === null ||
    originHostname === null ||
    !LOCAL_HOSTNAMES.has(hostname) ||
    !LOCAL_HOSTNAMES.has(originHostname)
  ) {
    return c.json({ error: "forbidden_origin" }, 403);
  }
  await next();
};
