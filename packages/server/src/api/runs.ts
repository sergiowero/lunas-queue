// Focus from the Runs tables (ADR runs-foco-pane): focuses in herdr the agent of a Run
// registered by LunasQ. It resolves the agent's name from the database, so the UI cannot move
// herdr's view to an arbitrary agent. It writes nothing: it is repeatable.
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
      return c.json({ error: "no_pane", message: "the Run has no herdr pane" }, 409);
    }
    if (!focus) return c.json({ error: "focus_unavailable" }, 503);
    try {
      await focus(run.herdrName);
    } catch (error) {
      if (isHerdrError(error, "agent_not_found")) {
        return c.json(
          { error: "agent_gone", message: `${run.herdrName} is no longer in herdr` },
          409,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "herdr_error", message }, 502);
    }
    return c.body(null, 204);
  });
}
