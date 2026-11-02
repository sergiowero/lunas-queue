// Inputs of the LunasQ MCP tools, the context returned by get_task_context and the events
// they write (docs/design.md §MCPs and skills, ADR uw-15-mcp-tools).
import { z } from "zod";
import { DeliveryConflictPayload } from "./delivery.ts";
import { Phase, QuestionStatus, RiskLabel, SubState, TaskState } from "./enums.ts";
import { checkUnique, list } from "./handoff/common.ts";
import {
  HandoffV1,
  ImplementationHandoff,
  MustFixFinding,
  REVIEWER_NAMES,
  VerificationHandoff,
} from "./handoff/index.ts";
import { QuestionOptions } from "./question.ts";
import { SpecContent } from "./spec.ts";
import { TaskNumber } from "./task.ts";

const TaskItemId = z.string().regex(/^T-[1-9]\d*$/, {
  error: "invalid task id: T-<n> expected, for example T-1",
});
const Prose = z.string().trim().min(1).max(2000);

// The handoff enters as any object: parseHandoff validates it with errors in English and
// with the cross-field rules, which the JSON Schema of the inputSchema cannot express.
export const HandoffInput = z.strictObject({
  handoff: z.record(z.string(), z.unknown()),
});
export type HandoffInput = z.infer<typeof HandoffInput>;

export const GetTaskContextInput = z.strictObject({});

export const AskHumanInput = z.strictObject({
  question: Prose,
  context: Prose.optional(),
  options: QuestionOptions.optional(),
});
export type AskHumanInput = z.infer<typeof AskHumanInput>;

export const UpdateChecklistInput = z
  .strictObject({
    items: list(z.strictObject({ taskId: TaskItemId, done: z.boolean() })).min(1),
  })
  .superRefine((input, ctx) => {
    checkUnique(
      ctx,
      input.items,
      (i) => i.taskId,
      (i) => ["items", i, "taskId"],
      "checklist item",
    );
  });
export type UpdateChecklistInput = z.infer<typeof UpdateChecklistInput>;

export const ReportFailureInput = z.strictObject({ reason: Prose });
export type ReportFailureInput = z.infer<typeof ReportFailureInput>;

export const ChecklistItem = z.strictObject({
  taskId: TaskItemId,
  title: z.string().min(1),
  done: z.boolean(),
});
export type ChecklistItem = z.infer<typeof ChecklistItem>;

export const CHECKLIST_UPDATED = "checklist.updated";
export const QUESTION_CREATED = "question.created";

// Full snapshot: the last event of the task is its current checklist.
export const ChecklistUpdatedPayload = z.strictObject({
  runId: z.uuid(),
  items: z.array(ChecklistItem),
});
export type ChecklistUpdatedPayload = z.infer<typeof ChecklistUpdatedPayload>;

export const VERDICT_RECORDED = "verification.verdict_recorded";

// Summary of the verdict for the Event log and the outbox; the full handoff stays in the Run. With
// pass, delivery (UW-26) starts with this event.
export const VerdictRecordedPayload = z.strictObject({
  runId: z.uuid(),
  verdict: z.enum(["pass", "reject"]),
  // Verification iteration of the Run, 0-based: the first verdict of the task has 0.
  iteration: z.int().min(0),
  riskLabel: RiskLabel,
  mustFix: z.int().min(0),
  refuted: z.int().min(0),
  skippedReviewers: z.array(z.enum(REVIEWER_NAMES)),
});
export type VerdictRecordedPayload = z.infer<typeof VerdictRecordedPayload>;

export const QuestionCreatedPayload = z.strictObject({ questionId: z.uuid(), runId: z.uuid() });
export type QuestionCreatedPayload = z.infer<typeof QuestionCreatedPayload>;

/** What the agent receives when its Run starts; each phase uses the parts that concern it. */
export const TaskContext = z.strictObject({
  task: z.strictObject({
    id: z.uuid(),
    number: TaskNumber,
    intent: z.string(),
    title: z.string().nullable(),
    tags: z.array(z.string()),
    state: TaskState,
    subState: SubState.nullable(),
    verificationIteration: z.int().min(0),
    branch: z.string().nullable(),
    worktreePath: z.string().nullable(),
  }),
  run: z.strictObject({ id: z.uuid(), phase: Phase, iteration: z.int().min(0) }),
  project: z.strictObject({
    name: z.string(),
    repo: z.string(),
    baseBranch: z.string(),
    testCommand: z.string().nullable(),
  }),
  // Implementation and verification always read the approved version.
  approvedSpec: z.strictObject({ version: z.int().min(1), content: SpecContent }).nullable(),
  // In a new refinement round: the last version with requested changes and its comments.
  changesRequested: z
    .strictObject({ version: z.int().min(1), content: SpecContent, comments: z.string() })
    .nullable(),
  // The last implementation handoff: claims that the verifier checks.
  implementation: ImplementationHandoff.nullable(),
  // Verdicts of previous iterations, from oldest to newest; only in verification.
  verificationHistory: z.array(VerificationHandoff),
  // In implementation after a reject: only the must-fix findings of the last verdict, with their evidence.
  rework: z
    .strictObject({ runId: z.uuid(), iteration: z.int().min(0), mustFix: z.array(MustFixFinding) })
    .nullable(),
  // In implementation after a delivery conflict (ADR uw-26-entrega): what prevented integrating the
  // base branch. It is cleared when the next verdict is recorded.
  deliveryConflict: DeliveryConflictPayload.nullable(),
  // Handoff of the last Run of the same phase, if it is retried.
  previousAttempt: z
    .strictObject({
      runId: z.uuid(),
      failureReason: z.string().nullable(),
      handoff: HandoffV1.nullable(),
    })
    .nullable(),
  questions: z.array(
    z.strictObject({
      id: z.uuid(),
      question: z.string(),
      context: z.string().nullable(),
      options: QuestionOptions.nullable(),
      status: QuestionStatus,
      answer: z.string().nullable(),
    }),
  ),
  checklist: z.array(ChecklistItem).nullable(),
});
export type TaskContext = z.infer<typeof TaskContext>;
