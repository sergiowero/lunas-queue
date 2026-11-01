// Foco desde las tablas de Runs (ADR runs-foco-pane): enfoca en herdr el agente de un Run
// registrado por LunasQ. Resuelve el nombre del agente desde la base, así la UI no puede mover
// la vista de herdr a un agente cualquiera. No escribe nada: es repetible.
import { isHerdrError } from "@lunasq/adapters";
import type { RunRepository } from "@lunasq/db";
import { Hono } from "hono";
import { notFound } from "./http.ts";
import type { AgentFocuser } from "./questions.ts";

export function runRoutes(runs: RunRepository, focus?: AgentFocuser): Hono {
  return new Hono().post("/:runId/focus", async (c) => {
    const run = runs.get(c.req.param("runId"));
    if (!run) return notFound(c);
    if (!run.herdrPane || !run.herdrName) {
      return c.json({ error: "no_pane", message: "el Run no tiene un pane de herdr" }, 409);
    }
    if (!focus) return c.json({ error: "focus_unavailable" }, 503);
    try {
      await focus(run.herdrName);
    } catch (error) {
      if (isHerdrError(error, "agent_not_found")) {
        return c.json(
          { error: "agent_gone", message: `${run.herdrName} ya no está en herdr` },
          409,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "herdr_error", message }, 502);
    }
    return c.body(null, 204);
  });
}
