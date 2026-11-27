// Spec routes and the human gate (ADR 0013), mounted under /api/tasks/:id/specs. The
// version delivered by the refiner comes in through the LunasQ MCP, not from here.
import type { SpecRepository, SpecResult } from "@lunasq/db";
import {
  SpecDiffQuery,
  SpecEditAndApprove,
  SpecRequestChanges,
  SpecVersionParam,
} from "@lunasq/schemas";
import { type Context, Hono } from "hono";
import { invalidInput, invalidJson, notFound, readJson } from "./http.ts";

function respond(c: Context, result: SpecResult) {
  if (result.ok) return c.json({ spec: result.spec, task: result.task });
  if (result.error.code === "task_not_found") return notFound(c, `task ${taskId(c)}`);
  if (result.error.code === "spec_not_found") return notFound(c, specWhat(c));
  return c.json({ error: result.error.code, message: result.error.message }, 409);
}

function taskId(c: Context): string {
  const id = c.req.param("id");
  if (!id) throw new Error("specs route mounted without :id");
  return id;
}

function specWhat(c: Context): string {
  return `spec version ${c.req.param("version")} of task ${taskId(c)}`;
}

export function specRoutes(specs: SpecRepository): Hono {
  return new Hono()
    .get("/", (c) => {
      const list = specs.list(taskId(c));
      return list ? c.json(list) : notFound(c, `task ${taskId(c)}`);
    })
    .get("/:version", (c) => {
      const version = SpecVersionParam.safeParse(c.req.param("version"));
      if (!version.success) return invalidInput(c, version.error);
      const spec = specs.get(taskId(c), version.data);
      return spec ? c.json(spec) : notFound(c, specWhat(c));
    })
    .get("/:version/diff", (c) => {
      const version = SpecVersionParam.safeParse(c.req.param("version"));
      if (!version.success) return invalidInput(c, version.error);
      const query = SpecDiffQuery.safeParse(c.req.query());
      if (!query.success) return invalidInput(c, query.error);
      const diff = specs.diff(taskId(c), version.data, query.data.against);
      return diff ? c.json(diff) : notFound(c, specWhat(c));
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
      if (!json.ok) return invalidJson(c);
      const input = SpecRequestChanges.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      return respond(c, specs.requestChanges(taskId(c), version.data, input.data.comments));
    })
    .post("/:version/edit-and-approve", async (c) => {
      const version = SpecVersionParam.safeParse(c.req.param("version"));
      if (!version.success) return invalidInput(c, version.error);
      const json = await readJson(c);
      if (!json.ok) return invalidJson(c);
      const input = SpecEditAndApprove.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      return respond(c, specs.editAndApprove(taskId(c), version.data, input.data.content));
    });
}
