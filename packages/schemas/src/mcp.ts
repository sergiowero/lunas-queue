// Entradas de las tools del LunasQ MCP, el contexto que devuelve get_task_context y los eventos
// que escriben (docs/design.md §MCPs y skills, ADR uw-15-mcp-tools).
import { z } from "zod";
import { Phase, QuestionStatus, RiskLabel, SubState, TaskState } from "./enums.ts";
import { checkUnique, list } from "./handoff/common.ts";
import {
  HandoffV1,
  ImplementationHandoff,
  MustFixFinding,
  REVIEWER_NAMES,
  VerificationHandoff,
} from "./handoff/index.ts";
import { SpecContent } from "./spec.ts";

const TaskItemId = z.string().regex(/^T-[1-9]\d*$/, {
  error: "id de tarea inválido: se esperaba T-<n>, por ejemplo T-1",
});
const Prose = z.string().trim().min(1).max(2000);

// El handoff entra como objeto cualquiera: parseHandoff lo valida con errores en español y
// con las reglas entre campos, que el JSON Schema del inputSchema no puede expresar.
export const HandoffInput = z.strictObject({
  handoff: z.record(z.string(), z.unknown()),
});
export type HandoffInput = z.infer<typeof HandoffInput>;

export const GetTaskContextInput = z.strictObject({});

export const AskHumanInput = z.strictObject({
  question: Prose,
  context: Prose.optional(),
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
      "item del checklist",
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

// Snapshot completo: el último evento de la tarea es su checklist vigente.
export const ChecklistUpdatedPayload = z.strictObject({
  runId: z.uuid(),
  items: z.array(ChecklistItem),
});
export type ChecklistUpdatedPayload = z.infer<typeof ChecklistUpdatedPayload>;

export const VERDICT_RECORDED = "verification.verdict_recorded";

// Resumen del veredicto para el Event log y el outbox; el handoff completo queda en el Run. Con
// pass, la entrega (UW-26) arranca con este evento.
export const VerdictRecordedPayload = z.strictObject({
  runId: z.uuid(),
  verdict: z.enum(["pass", "reject"]),
  // Iteración de verificación en la que se emitió (la del Run).
  iteration: z.int().min(0),
  riskLabel: RiskLabel,
  mustFix: z.int().min(0),
  refuted: z.int().min(0),
  skippedReviewers: z.array(z.enum(REVIEWER_NAMES)),
});
export type VerdictRecordedPayload = z.infer<typeof VerdictRecordedPayload>;

export const QuestionCreatedPayload = z.strictObject({ questionId: z.uuid(), runId: z.uuid() });
export type QuestionCreatedPayload = z.infer<typeof QuestionCreatedPayload>;

/** Lo que recibe el agente al empezar su Run; cada fase usa las partes que le tocan. */
export const TaskContext = z.strictObject({
  task: z.strictObject({
    id: z.uuid(),
    intent: z.string(),
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
  // Implementación y verificación leen siempre la versión aprobada.
  approvedSpec: z.strictObject({ version: z.int().min(1), content: SpecContent }).nullable(),
  // En una nueva ronda de refinamiento: la última versión con cambios pedidos y sus comentarios.
  changesRequested: z
    .strictObject({ version: z.int().min(1), content: SpecContent, comments: z.string() })
    .nullable(),
  // El último handoff de implementación: afirmaciones que el verificador comprueba.
  implementation: ImplementationHandoff.nullable(),
  // Veredictos de iteraciones anteriores, del más viejo al más nuevo; solo en verificación.
  verificationHistory: z.array(VerificationHandoff),
  // En implementación tras un reject: solo los must-fix del último veredicto, con su evidencia.
  rework: z
    .strictObject({ runId: z.uuid(), iteration: z.int().min(0), mustFix: z.array(MustFixFinding) })
    .nullable(),
  // Handoff del último Run de la misma fase, si se reintenta.
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
      status: QuestionStatus,
      answer: z.string().nullable(),
    }),
  ),
  checklist: z.array(ChecklistItem).nullable(),
});
export type TaskContext = z.infer<typeof TaskContext>;
