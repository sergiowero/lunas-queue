// Questions from the agent to the human (docs/design.md §Agent questions and blocks,
// ADR uw-22-preguntas). QUESTION_CREATED and the ask_human tool live in mcp.ts.
import { z } from "zod";
import { QuestionStatus } from "./enums.ts";
import { ShortText, Text } from "./handoff/common.ts";
import { SchedulablePhase } from "./scheduler.ts";

export const QUESTION_ANSWERED = "question.answered";
export const QUESTION_CANCELLED = "question.cancelled";

/** Body of `POST /api/questions/:id/answer`. */
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

export const QUESTION_OPTIONS_MIN = 2;
export const QUESTION_OPTIONS_MAX = 6;

/** Structured alternative the agent proposes: the label is what comes back as the answer. */
export const QuestionOption = z.strictObject({
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

/** 2 to 6 options with unique labels, case-insensitive and ignoring surrounding whitespace. */
export const QuestionOptions = z
  .array(QuestionOption)
  .min(QUESTION_OPTIONS_MIN)
  .max(QUESTION_OPTIONS_MAX)
  .superRefine((options, ctx) => {
    const seen = new Set<string>();
    options.forEach((option, index) => {
      const key = option.label.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "label"],
          message: `duplicate option label: ${option.label}`,
        });
      }
      seen.add(key);
    });
  });
export type QuestionOptions = z.infer<typeof QuestionOptions>;

export const Question = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  runId: z.uuid().nullable(),
  question: Text,
  context: Text.nullable(),
  options: QuestionOptions.nullable(),
  status: QuestionStatus,
  answer: Text.nullable(),
  answeredBy: ShortText.nullable(),
  answeredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Question = z.infer<typeof Question>;

/** `pane`: the answer went to the live agent; `new_run`: the pane no longer existed and it is redispatched. */
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

/** Agent waiting for a permission in its TUI: it is answered in herdr, in the agent's pane. */
export const BlockedAgent = z.strictObject({
  runId: z.uuid(),
  taskId: z.uuid(),
  phase: SchedulablePhase,
  agentName: ShortText,
  paneId: ShortText,
  since: z.iso.datetime(),
});
export type BlockedAgent = z.infer<typeof BlockedAgent>;
