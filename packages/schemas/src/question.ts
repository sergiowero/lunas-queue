// Preguntas del agente al humano (docs/design.md §Preguntas del agente y bloqueos,
// ADR uw-22-preguntas). QUESTION_CREATED y la tool ask_human viven en mcp.ts.
import { z } from "zod";
import { QuestionStatus } from "./enums.ts";
import { ShortText, Text } from "./handoff/common.ts";
import { SchedulablePhase } from "./scheduler.ts";

export const QUESTION_ANSWERED = "question.answered";
export const QUESTION_CANCELLED = "question.cancelled";

/** Cuerpo de `POST /api/questions/:id/answer`. */
export const QuestionAnswer = z.strictObject({
  answer: z.string().trim().min(1).max(2000),
  answeredBy: ShortText.optional(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

export const QuestionListQuery = z.strictObject({
  status: QuestionStatus.optional(),
  taskId: z.uuid().optional(),
  projectId: z.uuid().optional(),
});
export type QuestionListQuery = z.infer<typeof QuestionListQuery>;

export const Question = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  runId: z.uuid().nullable(),
  question: Text,
  context: Text.nullable(),
  status: QuestionStatus,
  answer: Text.nullable(),
  answeredBy: ShortText.nullable(),
  answeredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Question = z.infer<typeof Question>;

/** `pane`: la respuesta fue al agente vivo; `new_run`: el pane ya no existía y se redespacha. */
export const QuestionDelivery = z.enum(["pane", "new_run"]);
export type QuestionDelivery = z.infer<typeof QuestionDelivery>;

export const QuestionAnsweredPayload = z.strictObject({
  questionId: z.uuid(),
  runId: z.uuid().nullable(),
  delivery: QuestionDelivery,
  answeredBy: ShortText,
});
export type QuestionAnsweredPayload = z.infer<typeof QuestionAnsweredPayload>;

export const QuestionCancelledPayload = z.strictObject({
  questionId: z.uuid(),
  reason: z.enum(["task_cancelled", "left_waiting_human"]),
});
export type QuestionCancelledPayload = z.infer<typeof QuestionCancelledPayload>;

/** Agente que espera un permiso en su TUI: se responde en herdr, en el pane del agente. */
export const BlockedAgent = z.strictObject({
  runId: z.uuid(),
  taskId: z.uuid(),
  phase: SchedulablePhase,
  agentName: ShortText,
  paneId: ShortText,
  since: z.iso.datetime(),
});
export type BlockedAgent = z.infer<typeof BlockedAgent>;
