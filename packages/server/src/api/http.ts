// Ayudas compartidas por las rutas: lectura del cuerpo y respuestas de error comunes.
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

/** Como readJson, pero un cuerpo vacío vale `{}`: para acciones con cuerpo opcional. */
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

/**
 * Defensa contra DNS rebinding y peticiones cruzadas del navegador: la API local no tiene
 * autenticación, así que rechaza (403 forbidden_origin) cualquier Host u Origin que no sea localhost.
 */
export const localOriginOnly: MiddlewareHandler = async (c, next) => {
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
