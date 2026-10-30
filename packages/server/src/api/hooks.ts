// Vista de hooks por proyecto (UW-25), montada bajo /api/projects/:id/hooks. El contenido sale de
// lunasq/hooks/ en la rama base (HookService.listHooks) y las ejecuciones, del Event log: los
// hooks se editan por PR en el repo, no desde aquí.
import type { ProjectRepository, TaskViewRepository } from "@lunasq/db";
import { HookExecutionsQuery } from "@lunasq/schemas";
import { type Context, Hono } from "hono";
import { isHookError, type ProjectHooks } from "../hooks/service.ts";
import { invalidInput, notFound } from "./http.ts";

/** Lo que la vista necesita del HookService. */
export interface HookLister {
  listHooks(projectId: string): Promise<ProjectHooks>;
}

export interface HookRoutesDeps {
  projects: ProjectRepository;
  views: TaskViewRepository;
  /** Sin él, `GET /` responde 503: quien compone el servidor pasa el HookService. */
  hooks?: HookLister | undefined;
}

function projectId(c: Context): string {
  const id = c.req.param("id");
  if (!id) throw new Error("ruta de hooks montada sin :id");
  return id;
}

export function hookRoutes({ projects, views, hooks }: HookRoutesDeps): Hono {
  return new Hono()
    .get("/", async (c) => {
      if (!hooks)
        return c.json({ error: "hooks_unavailable", message: "sin servicio de hooks" }, 503);
      try {
        return c.json(await hooks.listHooks(projectId(c)));
      } catch (error) {
        if (isHookError(error, "project_not_found")) return notFound(c);
        // Sin red o sin la rama base no se sabe qué hooks hay: no es un fallo del servidor.
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: "hooks_unavailable", message }, 502);
      }
    })
    .get("/executions", (c) => {
      const query = HookExecutionsQuery.safeParse(c.req.query());
      if (!query.success) return invalidInput(c, query.error);
      const id = projectId(c);
      if (!projects.get(id)) return notFound(c);
      return c.json(views.hookExecutions(id, query.data.limit));
    });
}
