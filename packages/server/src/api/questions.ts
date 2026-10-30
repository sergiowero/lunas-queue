// Rutas de la bandeja de preguntas (UW-22, ADR uw-22-preguntas). Listar y consultar leen la base;
// responder lo hace el QuestionService, que habla con herdr. La validación vive en
// @lunasq/schemas y la lógica en QuestionRepository y QuestionService.
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

export function blockedRoutes(blocked: BlockedSource): Hono {
  return new Hono().get("/", (c) => c.json(blocked()));
}
