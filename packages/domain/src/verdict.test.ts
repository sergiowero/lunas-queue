import type { VerificationBody } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { checkReviewerEvidence, type SubagentEvidence } from "./verdict.ts";

const t0 = new Date("2026-10-29T10:00:00Z");
const t1 = new Date("2026-10-29T10:05:00Z");

const finished = (agentType: string): SubagentEvidence => ({
  agentType,
  startedAt: t0,
  stoppedAt: t1,
});

const finding = { severity: "major" as const, file: "src/a.ts", evidence: "falta validar" };

function body(overrides: Partial<VerificationBody> = {}): VerificationBody {
  return {
    verdict: "reject",
    criteriaVerdicts: [{ criterionId: "AC-1", verdict: "fail", evidence: "not met" }],
    reviewers: {
      "lunasq-security-reviewer": { status: "ran", findings: [] },
      "lunasq-ux-reviewer": { status: "skipped", justification: "sin front end" },
      "lunasq-ui-reviewer": { status: "skipped", justification: "sin front end" },
      "lunasq-code-reviewer": { status: "ran", findings: [finding] },
    },
    mustFix: [{ ...finding, source: "lunasq-code-reviewer" }],
    refuted: [],
    riskLabel: "medium",
    ...overrides,
  };
}

const ranBoth = [finished("lunasq-security-reviewer"), finished("lunasq-code-reviewer")];

describe("checkReviewerEvidence", () => {
  it("accepts ran reviewers with their execution finished and justified skipped ones", () => {
    expect(checkReviewerEvidence(body(), ranBoth)).toEqual([]);
  });

  it("accepts approver findings even if no reviewer reports them", () => {
    const b = body({ mustFix: [{ ...finding, source: "approver" }] });
    expect(checkReviewerEvidence(b, ranBoth)).toEqual([]);
  });

  it("rejects a ran reviewer that does not appear in the hooks", () => {
    expect(checkReviewerEvidence(body(), [finished("lunasq-code-reviewer")])).toEqual([
      {
        path: "body.reviewers.lunasq-security-reviewer",
        message: expect.stringContaining("does not appear in the Run's hooks"),
      },
    ]);
  });

  it("rejects a ran reviewer that started but did not finish", () => {
    const started = { agentType: "lunasq-security-reviewer", startedAt: t0, stoppedAt: null };
    const issues = checkReviewerEvidence(body(), [started, finished("lunasq-code-reviewer")]);
    expect(issues).toEqual([
      {
        path: "body.reviewers.lunasq-security-reviewer",
        message: expect.stringContaining("did not finish"),
      },
    ]);
  });

  it("accepts a ran reviewer with several executions if one finished", () => {
    const retry = { agentType: "lunasq-security-reviewer", startedAt: t0, stoppedAt: null };
    expect(checkReviewerEvidence(body(), [retry, ...ranBoth])).toEqual([]);
  });

  it("rejects a skipped reviewer that ran and finished", () => {
    const issues = checkReviewerEvidence(body(), [...ranBoth, finished("lunasq-ux-reviewer")]);
    expect(issues).toEqual([
      {
        path: "body.reviewers.lunasq-ux-reviewer",
        message: expect.stringContaining("is reported as skipped"),
      },
    ]);
  });

  it("accepts a skipped reviewer that started without finishing (it crashed and was justified)", () => {
    const crashed = { agentType: "lunasq-ux-reviewer", startedAt: t0, stoppedAt: null };
    expect(checkReviewerEvidence(body(), [...ranBoth, crashed])).toEqual([]);
  });

  it("ignores subagents that are not reviewers", () => {
    expect(checkReviewerEvidence(body(), [...ranBoth, finished("Explore")])).toEqual([]);
  });

  it("rejects must-fix and refuted attributed to a skipped reviewer", () => {
    const b = body({
      mustFix: [{ ...finding, source: "lunasq-ux-reviewer" }],
      refuted: [{ finding, reason: "not applicable", source: "lunasq-ui-reviewer" }],
    });
    expect(checkReviewerEvidence(b, ranBoth)).toEqual([
      { path: "body.mustFix[0].source", message: expect.stringContaining("skipped") },
      { path: "body.refuted[0].source", message: expect.stringContaining("skipped") },
    ]);
  });
});
