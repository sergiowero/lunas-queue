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
import { Question, QuestionOption } from "./question.ts";

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

  describe("opciones de AskHumanInput", () => {
    const ask = (options: unknown) => AskHumanInput.safeParse({ question: "¿Cuál?", options });
    const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Opción ${i + 1}` }));

    it("acepta de 2 a 6 opciones, con descripción opcional, y conserva el orden", () => {
      const parsed = ask([
        { label: "A", description: "la primera" },
        { label: "B" },
        { label: "C" },
      ]);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.options?.map((o) => o.label)).toEqual(["A", "B", "C"]);
      expect(ask(opts(2)).success).toBe(true);
      expect(ask(opts(6)).success).toBe(true);
    });

    it("sin options la pregunta es abierta", () => {
      expect(AskHumanInput.safeParse({ question: "¿Cuál?" }).data?.options).toBeUndefined();
    });

    it("rechaza una opción sola, siete, o una lista vacía", () => {
      expect(ask(opts(1)).success).toBe(false);
      expect(ask(opts(7)).success).toBe(false);
      expect(ask([]).success).toBe(false);
    });

    it("rechaza labels vacíos, en blanco o demasiado largos", () => {
      expect(ask([{ label: "" }, { label: "B" }]).success).toBe(false);
      expect(ask([{ label: "   " }, { label: "B" }]).success).toBe(false);
      expect(ask([{ label: "a".repeat(101) }, { label: "B" }]).success).toBe(false);
      expect(ask([{ label: "A", description: "d".repeat(501) }, { label: "B" }]).success).toBe(
        false,
      );
    });

    it("rechaza labels que solo difieren en mayúsculas o espacios extremos", () => {
      expect(ask([{ label: "Sí" }, { label: "sí" }]).success).toBe(false);
      expect(ask([{ label: "Sí" }, { label: "  Sí " }]).success).toBe(false);
      expect(ask([{ label: "Sí" }, { label: "No" }]).success).toBe(true);
    });

    it("rechaza campos desconocidos en una opción", () => {
      expect(QuestionOption.safeParse({ label: "A", extra: 1 }).success).toBe(false);
    });
  });

  it("Question expone options nulo o la lista de opciones", () => {
    const base = {
      id: questionId,
      taskId: runId,
      runId: null,
      question: "¿Cuál?",
      context: null,
      status: "open",
      answer: null,
      answeredBy: null,
      answeredAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(Question.safeParse({ ...base, options: null }).success).toBe(true);
    expect(Question.safeParse({ ...base, options: [{ label: "A" }, { label: "B" }] }).success).toBe(
      true,
    );
    expect(Question.safeParse(base).success).toBe(false);
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
