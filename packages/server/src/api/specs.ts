// Rutas de specs y del gate humano (UW-12, ADR 0013), montadas bajo /api/tasks/:id/specs. La
// versión entregada por el refinador entra por el LunasQ MCP (UW-15), no por aquí.
import type { SpecRepository, SpecResult } from "@lunasq/db";
import {
  SpecDiffQuery,
  SpecEditAndApprove,
  SpecRequestChanges,
  SpecVersionParam,
} from "@lunasq/schemas";
import { type Context, Hono } from "hono";
import { invalidInput, notFound, readJson } from "./http.ts";

const NOT_FOUND = new Set(["task_not_found", "spec_not_found"]);

function respond(c: Context, result: SpecResult) {
  if (result.ok) return c.json({ spec: result.spec, task: result.task });
  if (NOT_FOUND.has(result.error.code)) return notFound(c);
  return c.json({ error: result.error.code, message: result.error.message }, 409);
}

function taskId(c: Context): string {
  const id = c.req.param("id");
  if (!id) throw new Error("ruta de specs montada sin :id");
  return id;
}

export function specRoutes(specs: SpecRepository): Hono {
  return new Hono()
    .get("/", (c) => {
      const list = specs.list(taskId(c));
      return list ? c.json(list) : notFound(c);
    })
    .get("/:version", (c) => {
      const version = SpecVersionParam.safeParse(c.req.param("version"));
      if (!version.success) return invalidInput(c, version.error);
      const spec = specs.get(taskId(c), version.data);
      return spec ? c.json(spec) : notFound(c);
    })
    .get("/:version/diff", (c) => {
      const version = SpecVersionParam.safeParse(c.req.param("version"));
      if (!version.success) return invalidInput(c, version.error);
      const query = SpecDiffQuery.safeParse(c.req.query());
      if (!query.success) return invalidInput(c, query.error);
      const diff = specs.diff(taskId(c), version.data, query.data.against);
      return diff ? c.json(diff) : notFound(c);
    })
    .post("/:version/approve", (c) => {
      const version = SpecVersionParam.safeParse(c.req.param("version"));
      if (!version.success) return invalidInput(c, version.error);
      return respond(c, specs.approve(taskId(c), version.data));
    })
    .post("/:version/request-changes", async (c) => {
      const version = SpecVersionParam.safeParse(c.req.param("version"));
      if (!version.success) return invalidInput(c, version.error);
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: "invalid_json" }, 400);
      const input = SpecRequestChanges.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      return respond(c, specs.requestChanges(taskId(c), version.data, input.data.comments));
    })
    .post("/:version/edit-and-approve", async (c) => {
      const version = SpecVersionParam.safeParse(c.req.param("version"));
      if (!version.success) return invalidInput(c, version.error);
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: "invalid_json" }, 400);
      const input = SpecEditAndApprove.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      return respond(c, specs.editAndApprove(taskId(c), version.data, input.data.content));
    });
}
