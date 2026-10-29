// Rutas de proyectos (UW-05). La validación vive en los esquemas de @lunasq/schemas; aquí solo se
// traducen sus errores y los del repositorio a códigos HTTP.
import { type ProjectRepository, ProjectRepositoryError } from "@lunasq/db";
import { ProjectCreate, ProjectUpdate } from "@lunasq/schemas";
import { type Context, Hono } from "hono";
import { invalidInput, notFound, readJson } from "./http.ts";

function repositoryError(c: Context, error: unknown) {
  if (error instanceof ProjectRepositoryError && error.code !== "invalid_row") {
    return c.json({ error: error.code, field: error.field, message: error.message }, 409);
  }
  throw error;
}

export function projectRoutes(projects: ProjectRepository): Hono {
  return new Hono()
    .get("/", (c) => c.json(projects.list()))
    .post("/", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: "invalid_json" }, 400);
      const input = ProjectCreate.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      try {
        return c.json(projects.create(input.data), 201);
      } catch (error) {
        return repositoryError(c, error);
      }
    })
    .get("/:id", (c) => {
      const project = projects.get(c.req.param("id"));
      return project ? c.json(project) : notFound(c);
    })
    .patch("/:id", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: "invalid_json" }, 400);
      const patch = ProjectUpdate.safeParse(json.body);
      if (!patch.success) return invalidInput(c, patch.error);
      try {
        const project = projects.update(c.req.param("id"), patch.data);
        return project ? c.json(project) : notFound(c);
      } catch (error) {
        return repositoryError(c, error);
      }
    })
    .delete("/:id", (c) => {
      try {
        return projects.delete(c.req.param("id")) ? c.body(null, 204) : notFound(c);
      } catch (error) {
        return repositoryError(c, error);
      }
    });
}
