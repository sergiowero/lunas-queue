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

describe("LunasQ MCP tool inputs", () => {
  it("HandoffInput accepts any object: the handoff is validated by parseHandoff", () => {
    expect(HandoffInput.safeParse({ handoff: { phase: "x" } }).success).toBe(true);
    expect(HandoffInput.safeParse({ handoff: "texto" }).success).toBe(false);
    expect(HandoffInput.safeParse({}).success).toBe(false);
  });

  it("AskHumanInput requires a non-empty question and bounds its size", () => {
    expect(AskHumanInput.safeParse({ question: "Do I drop the table?" }).success).toBe(true);
    expect(AskHumanInput.safeParse({ question: "  " }).success).toBe(false);
    expect(AskHumanInput.safeParse({ question: "a".repeat(2001) }).success).toBe(false);
  });

  describe("AskHumanInput options", () => {
    const ask = (options: unknown) => AskHumanInput.safeParse({ question: "Which one?", options });
    const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Option ${i + 1}` }));

    it("accepts 2 to 6 options, with optional description, and keeps the order", () => {
      const parsed = ask([
        { label: "A", description: "the first" },
        { label: "B" },
        { label: "C" },
      ]);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.options?.map((o) => o.label)).toEqual(["A", "B", "C"]);
      expect(ask(opts(2)).success).toBe(true);
      expect(ask(opts(6)).success).toBe(true);
    });

    it("without options the question is open", () => {
      expect(AskHumanInput.safeParse({ question: "Which one?" }).data?.options).toBeUndefined();
    });

    it("rejects a single option, seven, or an empty list", () => {
      expect(ask(opts(1)).success).toBe(false);
      expect(ask(opts(7)).success).toBe(false);
      expect(ask([]).success).toBe(false);
    });

    it("rejects empty, blank or too long labels", () => {
      expect(ask([{ label: "" }, { label: "B" }]).success).toBe(false);
      expect(ask([{ label: "   " }, { label: "B" }]).success).toBe(false);
      expect(ask([{ label: "a".repeat(101) }, { label: "B" }]).success).toBe(false);
      expect(ask([{ label: "A", description: "d".repeat(501) }, { label: "B" }]).success).toBe(
        false,
      );
    });

    it("rejects labels that only differ in case or surrounding whitespace", () => {
      expect(ask([{ label: "Yes" }, { label: "yes" }]).success).toBe(false);
      expect(ask([{ label: "Yes" }, { label: "  Yes " }]).success).toBe(false);
      expect(ask([{ label: "Yes" }, { label: "No" }]).success).toBe(true);
    });

    it("rejects unknown fields in an option", () => {
      expect(QuestionOption.safeParse({ label: "A", extra: 1 }).success).toBe(false);
    });
  });

  it("Question exposes options as null or the list of options", () => {
    const base = {
      id: questionId,
      taskId: runId,
      runId: null,
      question: "Which one?",
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

  it("UpdateChecklistInput requires unique T-<n> ids", () => {
    expect(UpdateChecklistInput.safeParse({ items: [{ taskId: "T-1", done: true }] }).success).toBe(
      true,
    );
    expect(UpdateChecklistInput.safeParse({ items: [] }).success).toBe(false);
    expect(
      UpdateChecklistInput.safeParse({ items: [{ taskId: "task", done: true }] }).success,
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

  it("ReportFailureInput requires a reason", () => {
    expect(ReportFailureInput.safeParse({ reason: "no compila la base" }).success).toBe(true);
    expect(ReportFailureInput.safeParse({ reason: "" }).success).toBe(false);
  });
});

describe("payloads of LunasQ MCP events", () => {
  it("checklist.updated stores the full checklist of the Run", () => {
    const payload = { runId, items: [{ taskId: "T-1", title: "Comando", done: true }] };
    expect(ChecklistUpdatedPayload.parse(payload)).toEqual(payload);
    expect(ChecklistUpdatedPayload.safeParse({ runId, items: [], extra: 1 }).success).toBe(false);
  });

  it("verification.verdict_recorded summarizes the verdict with risk and counts", () => {
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
      VerdictRecordedPayload.safeParse({ ...payload, skippedReviewers: ["other"] }).success,
    ).toBe(false);
  });

  it("question.created links the question with its Run", () => {
    expect(QuestionCreatedPayload.safeParse({ questionId, runId }).success).toBe(true);
    expect(QuestionCreatedPayload.safeParse({ questionId }).success).toBe(false);
  });
});
