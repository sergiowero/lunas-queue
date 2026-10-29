// Ayudas compartidas por las rutas: lectura del cuerpo y respuestas de error comunes.
import type { Context } from "hono";

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
