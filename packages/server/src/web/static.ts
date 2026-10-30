// Estáticos del front end (UW-21): el build de packages/web se sirve desde el mismo proceso. Las
// rutas del cliente (TanStack Router) reciben index.html; la API y los assets faltantes, su 404.
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { SUBAGENT_HOOK_PATH } from "../subagents/routes.ts";

const SERVER_PREFIXES = ["/api", "/mcp", SUBAGENT_HOOK_PATH, "/assets"];

/** Rutas del router del cliente: ni de la API ni archivos (`/favicon.ico` faltante da 404). */
function isClientRoute(path: string): boolean {
  if (SERVER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return false;
  }
  return !/\.[^/]+$/.test(path);
}

export function webRoutes(root: string): Hono {
  const index = join(root, "index.html");
  const fallback = serveStatic({ path: index });
  return new Hono()
    .use("*", serveStatic({ root }))
    .get("*", (c, next) => (isClientRoute(c.req.path) ? fallback(c, next) : next()));
}
