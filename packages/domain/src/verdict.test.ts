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
    criteriaVerdicts: [{ criterionId: "AC-1", verdict: "fail", evidence: "no cumple" }],
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
  it("acepta revisores ran con su ejecución terminada y omitidos justificados", () => {
    expect(checkReviewerEvidence(body(), ranBoth)).toEqual([]);
  });

  it("acepta hallazgos del approver aunque ningún revisor los reporte", () => {
    const b = body({ mustFix: [{ ...finding, source: "approver" }] });
    expect(checkReviewerEvidence(b, ranBoth)).toEqual([]);
  });

  it("rechaza un revisor ran que no aparece en los hooks", () => {
    expect(checkReviewerEvidence(body(), [finished("lunasq-code-reviewer")])).toEqual([
      {
        path: "body.reviewers.lunasq-security-reviewer",
        message: expect.stringContaining("no aparece en los hooks"),
      },
    ]);
  });

  it("rechaza un revisor ran que empezó pero no terminó", () => {
    const started = { agentType: "lunasq-security-reviewer", startedAt: t0, stoppedAt: null };
    const issues = checkReviewerEvidence(body(), [started, finished("lunasq-code-reviewer")]);
    expect(issues).toEqual([
      {
        path: "body.reviewers.lunasq-security-reviewer",
        message: expect.stringContaining("no terminó"),
      },
    ]);
  });

  it("acepta un revisor ran con varias ejecuciones si alguna terminó", () => {
    const retry = { agentType: "lunasq-security-reviewer", startedAt: t0, stoppedAt: null };
    expect(checkReviewerEvidence(body(), [retry, ...ranBoth])).toEqual([]);
  });

  it("rechaza un revisor skipped que corrió y terminó", () => {
    const issues = checkReviewerEvidence(body(), [...ranBoth, finished("lunasq-ux-reviewer")]);
    expect(issues).toEqual([
      {
        path: "body.reviewers.lunasq-ux-reviewer",
        message: expect.stringContaining("se reporta omitido"),
      },
    ]);
  });

  it("acepta un revisor skipped que empezó sin terminar (se cayó y se justificó)", () => {
    const crashed = { agentType: "lunasq-ux-reviewer", startedAt: t0, stoppedAt: null };
    expect(checkReviewerEvidence(body(), [...ranBoth, crashed])).toEqual([]);
  });

  it("ignora subagentes que no son revisores", () => {
    expect(checkReviewerEvidence(body(), [...ranBoth, finished("Explore")])).toEqual([]);
  });

  it("rechaza must-fix y refutados atribuidos a un revisor omitido", () => {
    const b = body({
      mustFix: [{ ...finding, source: "lunasq-ux-reviewer" }],
      refuted: [{ finding, reason: "no aplica", source: "lunasq-ui-reviewer" }],
    });
    expect(checkReviewerEvidence(b, ranBoth)).toEqual([
      { path: "body.mustFix[0].source", message: expect.stringContaining("omitido") },
      { path: "body.refuted[0].source", message: expect.stringContaining("omitido") },
    ]);
  });
});
