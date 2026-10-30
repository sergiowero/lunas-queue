// Rutas de la bandeja de preguntas (UW-22, ADR uw-22-preguntas). Listar y consultar leen la base;
// responder lo hace el QuestionService, que habla con herdr. La validación vive en
// @lunasq/schemas y la lógica en QuestionRepository y QuestionService.
import { isHerdrError } from "@lunasq/adapters";
import type { QuestionRepository, QuestionRow } from "@lunasq/db";
import {
  type BlockedAgent,
  type Question,
  QuestionAnswer,
  QuestionListQuery,
} from "@lunasq/schemas";
import { Hono } from "hono";
import type { AnswerOutcome } from "../questions/service.ts";
import { invalidInput, notFound, readJson } from "./http.ts";

export interface QuestionAnswerer {
  answer(id: string, input: QuestionAnswer): Promise<AnswerOutcome>;
}

/** Los agentes bloqueados por un permiso en este momento (los observa el RunWatcher). */
export type BlockedSource = () => BlockedAgent[];

/** Enfoca en herdr el pane de un agente por su nombre (`HerdrAdapter.focusAgent`). */
export type AgentFocuser = (agentName: string) => Promise<unknown>;

export function toQuestion(row: QuestionRow): Question {
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    question: row.question,
    context: row.context,
    status: row.status,
    answer: row.answer,
    answeredBy: row.answeredBy,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function questionRoutes(questions: QuestionRepository, answerer?: QuestionAnswerer): Hono {
  return new Hono()
    .get("/", (c) => {
      const query = QuestionListQuery.safeParse(c.req.query());
      if (!query.success) return invalidInput(c, query.error);
      return c.json(questions.list(query.data).map(toQuestion));
    })
    .get("/:id", (c) => {
      const row = questions.get(c.req.param("id"));
      return row ? c.json(toQuestion(row)) : notFound(c);
    })
    .post("/:id/answer", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: "invalid_json" }, 400);
      const input = QuestionAnswer.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      const id = c.req.param("id");
      if (!questions.get(id)) return notFound(c);
      if (!answerer) return c.json({ error: "answering_unavailable" }, 503);
      const result = await answerer.answer(id, input.data);
      if (!result.ok) {
        const { code, message } = result.error;
        return c.json({ error: code, message }, code === "not_found" ? 404 : 409);
      }
      return c.json({ question: toQuestion(result.question), delivery: result.delivery });
    });
}

/**
 * El acceso de la bandeja al pane (ADR uw-27-bandeja): solo enfoca agentes que el RunWatcher ve
 * bloqueados, así la UI no puede mover la vista de herdr a un agente cualquiera.
 */
export function blockedRoutes(blocked: BlockedSource, focus?: AgentFocuser): Hono {
  return new Hono()
    .get("/", (c) => c.json(blocked()))
    .post("/:runId/focus", async (c) => {
      const agent = blocked().find((b) => b.runId === c.req.param("runId"));
      if (!agent) {
        return c.json(
          { error: "not_blocked", message: "el Run no tiene un agente bloqueado" },
          404,
        );
      }
      if (!focus) return c.json({ error: "focus_unavailable" }, 503);
      try {
        await focus(agent.agentName);
      } catch (error) {
        if (isHerdrError(error, "agent_not_found")) {
          return c.json(
            { error: "agent_gone", message: `${agent.agentName} ya no está en herdr` },
            409,
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: "herdr_error", message }, 502);
      }
      return c.body(null, 204);
    });
}
