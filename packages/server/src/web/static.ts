// Front end statics (UW-21): the packages/web build is served from the same process. The
// client routes (TanStack Router) receive index.html; the API and missing assets, their 404.
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { SUBAGENT_HOOK_PATH } from "../subagents/routes.ts";

const SERVER_PREFIXES = ["/api", "/mcp", SUBAGENT_HOOK_PATH, "/assets"];

/** Client router routes: neither API nor files (a missing `/favicon.ico` gives 404). */
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
