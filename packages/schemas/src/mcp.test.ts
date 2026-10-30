import { describe, expect, it } from "vitest";
import {
  AskHumanInput,
  ChecklistUpdatedPayload,
  HandoffInput,
  QuestionCreatedPayload,
  ReportFailureInput,
  UpdateChecklistInput,
  VerdictRecordedPayload,
} from "./mcp.ts";

const runId = "00000000-0000-4000-8000-000000000001";
const questionId = "00000000-0000-4000-8000-000000000002";

describe("entradas de las tools del LunasQ MCP", () => {
  it("HandoffInput acepta cualquier objeto: el handoff lo valida parseHandoff", () => {
    expect(HandoffInput.safeParse({ handoff: { phase: "x" } }).success).toBe(true);
    expect(HandoffInput.safeParse({ handoff: "texto" }).success).toBe(false);
    expect(HandoffInput.safeParse({}).success).toBe(false);
  });

  it("AskHumanInput exige pregunta no vacía y acota su tamaño", () => {
    expect(AskHumanInput.safeParse({ question: "¿Borro la tabla?" }).success).toBe(true);
    expect(AskHumanInput.safeParse({ question: "  " }).success).toBe(false);
    expect(AskHumanInput.safeParse({ question: "a".repeat(2001) }).success).toBe(false);
  });

  it("UpdateChecklistInput exige ids T-<n> únicos", () => {
    expect(UpdateChecklistInput.safeParse({ items: [{ taskId: "T-1", done: true }] }).success).toBe(
      true,
    );
    expect(UpdateChecklistInput.safeParse({ items: [] }).success).toBe(false);
    expect(
      UpdateChecklistInput.safeParse({ items: [{ taskId: "tarea", done: true }] }).success,
    ).toBe(false);
    expect(
      UpdateChecklistInput.safeParse({
        items: [
          { taskId: "T-1", done: true },
          { taskId: "T-1", done: false },
        ],
      }).success,
    ).toBe(false);
  });

  it("ReportFailureInput exige un motivo", () => {
    expect(ReportFailureInput.safeParse({ reason: "no compila la base" }).success).toBe(true);
    expect(ReportFailureInput.safeParse({ reason: "" }).success).toBe(false);
  });
});

describe("payloads de eventos del LunasQ MCP", () => {
  it("checklist.updated guarda el checklist completo del Run", () => {
    const payload = { runId, items: [{ taskId: "T-1", title: "Comando", done: true }] };
    expect(ChecklistUpdatedPayload.parse(payload)).toEqual(payload);
    expect(ChecklistUpdatedPayload.safeParse({ runId, items: [], extra: 1 }).success).toBe(false);
  });

  it("verification.verdict_recorded resume el veredicto con riesgo y conteos", () => {
    const payload = {
      runId,
      verdict: "reject",
      iteration: 1,
      riskLabel: "high",
      mustFix: 2,
      refuted: 1,
      skippedReviewers: ["lunasq-ui-reviewer"],
    };
    expect(VerdictRecordedPayload.parse(payload)).toEqual(payload);
    expect(VerdictRecordedPayload.safeParse({ ...payload, riskLabel: "x" }).success).toBe(false);
    expect(
      VerdictRecordedPayload.safeParse({ ...payload, skippedReviewers: ["otro"] }).success,
    ).toBe(false);
  });

  it("question.created liga la pregunta con su Run", () => {
    expect(QuestionCreatedPayload.safeParse({ questionId, runId }).success).toBe(true);
    expect(QuestionCreatedPayload.safeParse({ questionId }).success).toBe(false);
  });
});
