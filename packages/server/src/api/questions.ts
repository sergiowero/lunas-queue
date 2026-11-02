// Question inbox routes (UW-22, ADR uw-22-preguntas). Listing and querying read the database;
// answering is done by the QuestionService, which talks to herdr. Validation lives in
// @lunasq/schemas and the logic in QuestionRepository and QuestionService.
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

/** The agents blocked by a permission right now (observed by the RunWatcher). */
export type BlockedSource = () => BlockedAgent[];

/** Focuses an agent's pane in herdr by its name (`HerdrAdapter.focusAgent`). */
export type AgentFocuser = (agentName: string) => Promise<unknown>;

export function toQuestion(row: QuestionRow): Question {
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    question: row.question,
    context: row.context,
    options: row.options,
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
 * The inbox's access to the pane (ADR uw-27-bandeja): it only focuses agents the RunWatcher sees
 * blocked, so the UI cannot move herdr's view to an arbitrary agent.
 */
export function blockedRoutes(blocked: BlockedSource, focus?: AgentFocuser): Hono {
  return new Hono()
    .get("/", (c) => c.json(blocked()))
    .post("/:runId/focus", async (c) => {
      const agent = blocked().find((b) => b.runId === c.req.param("runId"));
      if (!agent) {
        return c.json({ error: "not_blocked", message: "the Run has no blocked agent" }, 404);
      }
      if (!focus) return c.json({ error: "focus_unavailable" }, 503);
      try {
        await focus(agent.agentName);
      } catch (error) {
        if (isHerdrError(error, "agent_not_found")) {
          return c.json(
            { error: "agent_gone", message: `${agent.agentName} is no longer in herdr` },
            409,
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: "herdr_error", message }, 502);
      }
      return c.body(null, 204);
    });
}
