// Composición de la API HTTP. El servidor (listen, SSE, MCP) se monta en unidades posteriores.
import {
  type LunasqDatabase,
  ProjectRepository,
  ProjectRepositoryError,
  SpecRepository,
  SpecRepositoryError,
  TaskRepository,
  TaskRepositoryError,
} from "@lunasq/db";
import { Hono } from "hono";
import { projectRoutes } from "./api/projects.ts";
import { specRoutes } from "./api/specs.ts";
import { taskRoutes } from "./api/tasks.ts";

export interface AppDeps {
  db: LunasqDatabase;
}

export function createApp({ db }: AppDeps): Hono {
  return new Hono()
    .route("/api/projects", projectRoutes(new ProjectRepository(db)))
    .route("/api/tasks/:id/specs", specRoutes(new SpecRepository(db)))
    .route("/api/tasks", taskRoutes(new TaskRepository(db)))
    .onError((error, c) => {
      if (
        error instanceof ProjectRepositoryError ||
        error instanceof TaskRepositoryError ||
        error instanceof SpecRepositoryError
      ) {
        return c.json({ error: error.code, message: error.message }, 500);
      }
      return c.json({ error: "internal" }, 500);
    });
}
