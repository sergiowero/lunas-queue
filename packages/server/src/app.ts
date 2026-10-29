// Composición de la API HTTP. El servidor (listen, SSE, MCP) se monta en unidades posteriores.
import { type LunasqDatabase, ProjectRepository } from "@lunasq/db";
import { Hono } from "hono";
import { projectRoutes } from "./api/projects.ts";

export interface AppDeps {
  db: LunasqDatabase;
}

export function createApp({ db }: AppDeps): Hono {
  return new Hono().route("/api/projects", projectRoutes(new ProjectRepository(db)));
}
