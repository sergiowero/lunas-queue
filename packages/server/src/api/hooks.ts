// Per-project hooks view (UW-25), mounted under /api/projects/:id/hooks. The content comes from
// lunasq/hooks/ on the base branch (HookService.listHooks) and the executions from the Event log: hooks
// are edited through a PR in the repo, not from here.
import type { ProjectRepository, TaskViewRepository } from "@lunasq/db";
import { HookExecutionsQuery } from "@lunasq/schemas";
import { type Context, Hono } from "hono";
import { isHookError, type ProjectHooks } from "../hooks/service.ts";
import { invalidInput, notFound } from "./http.ts";

/** What the view needs from the HookService. */
export interface HookLister {
  listHooks(projectId: string): Promise<ProjectHooks>;
}

export interface HookRoutesDeps {
  projects: ProjectRepository;
  views: TaskViewRepository;
  /** Without it, `GET /` answers 503: whoever composes the server passes the HookService. */
  hooks?: HookLister | undefined;
}

function projectId(c: Context): string {
  const id = c.req.param("id");
  if (!id) throw new Error("hooks route mounted without :id");
  return id;
}

export function hookRoutes({ projects, views, hooks }: HookRoutesDeps): Hono {
  return new Hono()
    .get("/", async (c) => {
      if (!hooks) return c.json({ error: "hooks_unavailable", message: "no hooks service" }, 503);
      try {
        return c.json(await hooks.listHooks(projectId(c)));
      } catch (error) {
        if (isHookError(error, "project_not_found")) return notFound(c);
        // Without network or the base branch it is unknown which hooks exist: it is not a server failure.
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
