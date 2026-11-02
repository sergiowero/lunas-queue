// Pure delivery rules (docs/design.md §Delivery, ADR uw-26-entrega): the facts that
// `verdict_pass` requires, the trailers of each commit and the title, body and label of the PR.
// Rebase, push and `gh` belong to the adapter; orchestrating them belongs to `DeliveryService` (server).
import {
  COMMIT_TRAILER_RUN,
  COMMIT_TRAILER_TASK,
  type Phase,
  type RiskLabel,
} from "@lunasq/schemas";

export interface DeliveryCriterion {
  id: string;
  given: string;
  when: string;
  outcome: string;
}

/** The part of the verifier's verdict that delivery uses. */
export interface DeliveryVerdict {
  verdict: "pass" | "reject";
  criteriaVerdicts: { criterionId: string; verdict: "pass" | "fail"; evidence: string }[];
  reviewers: Record<string, { status: "ran" | "skipped"; justification?: string }>;
  refuted: unknown[];
  riskLabel: RiskLabel;
}

export interface DeliveryFacts {
  verifierPassed: boolean;
  testsCoherent: boolean;
  allCriteriaPassed: boolean;
}

/**
 * The facts the state machine requires for `verdict_pass` besides the gate and the PR: the
 * verdict is pass, every criterion of the spec has at least one test in the implementation
 * handoff and every criterion passed in the verdict.
 */
export function deliveryFacts(input: {
  criteria: readonly { id: string }[];
  implementation: { criterionTests: { criterionId: string; tests: readonly unknown[] }[] } | null;
  verification: Pick<DeliveryVerdict, "verdict" | "criteriaVerdicts">;
}): DeliveryFacts {
  const tested = new Set(
    (input.implementation?.criterionTests ?? [])
      .filter((c) => c.tests.length > 0)
      .map((c) => c.criterionId),
  );
  const passed = new Set(
    input.verification.criteriaVerdicts
      .filter((c) => c.verdict === "pass")
      .map((c) => c.criterionId),
  );
  return {
    verifierPassed: input.verification.verdict === "pass",
    testsCoherent: input.criteria.every((c) => tested.has(c.id)),
    allCriteriaPassed: input.criteria.every((c) => passed.has(c.id)),
  };
}

/**
 * Trailers of each commit of the task (by sha): the task and the implementation Run that was
 * alive when it was written. A commit before every Run uses the first one; without
 * implementation Runs, `fallbackRunId`. A commit that already carries the trailers (those of the
 * hooks) keeps its own: the adapter does not repeat a key.
 */
export function commitTrailers(input: {
  taskId: string;
  commits: readonly { sha: string; authoredAt: Date }[];
  runs: readonly { id: string; phase: Phase; startedAt: Date }[];
  fallbackRunId: string;
}): Record<string, Record<string, string>> {
  const implementation = input.runs
    .filter((r) => r.phase === "implement")
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const result: Record<string, Record<string, string>> = {};
  for (const commit of input.commits) {
    const alive = implementation.filter((r) => r.startedAt <= commit.authoredAt).at(-1);
    result[commit.sha] = {
      [COMMIT_TRAILER_TASK]: input.taskId,
      [COMMIT_TRAILER_RUN]: (alive ?? implementation[0])?.id ?? input.fallbackRunId,
    };
  }
  return result;
}

const MAX_TITLE_CHARS = 72;

/**
 * PR title: the task's and, while it has none, the first line of the intent, on one line
 * and up to 72 characters.
 */
export function prTitle(intent: string, title?: string | null): string {
  const line = [title ?? "", ...intent.split("\n")]
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l !== "");
  if (!line) return "LunasQ task";
  return line.length <= MAX_TITLE_CHARS ? line : `${line.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

const RISK_LABELS: Record<RiskLabel, { name: string; color: string; description: string }> = {
  low: {
    name: "lunasq:risk-low",
    color: "0e8a16",
    description: "Low risk according to the verifier",
  },
  medium: {
    name: "lunasq:risk-medium",
    color: "fbca04",
    description: "Medium risk according to the verifier",
  },
  high: {
    name: "lunasq:risk-high",
    color: "b60205",
    description: "High risk according to the verifier",
  },
};

/** GitHub label for the risk the approver assigned, to prioritize the review. */
export function riskPrLabel(risk: RiskLabel) {
  return RISK_LABELS[risk];
}

const RISK_TEXT: Record<RiskLabel, string> = { low: "low", medium: "medium", high: "high" };

/** GitHub's limit for a PR body is 65,536; some margin is left. */
export const MAX_PR_BODY_CHARS = 60_000;

const MAX_EVIDENCE_CHARS = 1_500;

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/**
 * PR description: intent, criteria with their evidence, risk label, review and the
 * traceability trailers (docs/design.md §Delivery). It comes from the handoffs: delivery has no
 * agente (ADR uw-18-skills-fase).
 */
export function prBody(input: {
  taskId: string;
  runId: string;
  intent: string;
  specVersion: number;
  criteria: readonly DeliveryCriterion[];
  verification: DeliveryVerdict;
  evidencePath: string;
  baseBranch: string;
}): string {
  const verdicts = new Map(input.verification.criteriaVerdicts.map((c) => [c.criterionId, c]));
  const criteria = input.criteria.map((c) => {
    const verdict = verdicts.get(c.id);
    const mark = verdict?.verdict === "pass" ? "✅" : "❌";
    return [
      `- ${mark} **${c.id}** — given ${c.given}, when ${c.when}, then ${c.outcome}.`,
      verdict ? `  - Evidencia: ${clip(verdict.evidence, MAX_EVIDENCE_CHARS)}` : "  - No verdict.",
    ].join("\n");
  });
  const reviewers = Object.entries(input.verification.reviewers).map(([name, report]) =>
    report.status === "ran"
      ? `- \`${name}\`: reviewed`
      : `- \`${name}\`: skipped — ${report.justification ?? "no justification"}`,
  );
  const refuted = input.verification.refuted.length;
  const sections = [
    `## Intent\n\n${input.intent.trim()}`,
    `## Acceptance criteria (spec v${input.specVersion})\n\n${criteria.join("\n")}`,
    `## Risk\n\nRisk: **${RISK_TEXT[input.verification.riskLabel]}** (label \`${RISK_LABELS[input.verification.riskLabel].name}\`), according to the verifier.`,
    `## Verification\n\n${reviewers.join("\n")}\n\n${refuted} finding${refuted === 1 ? "" : "s"} refuted by the approver. Branch integrated with \`${input.baseBranch}\` and test suite green before the push.`,
    `## Traceability\n\nFull evidence of each Run: \`${input.evidencePath}\`.`,
  ];
  const trailers = `\n\n---\n\n${COMMIT_TRAILER_TASK}: ${input.taskId}\n${COMMIT_TRAILER_RUN}: ${input.runId}\n`;
  const body = sections.join("\n\n");
  const room = MAX_PR_BODY_CHARS - trailers.length;
  return body.length <= room
    ? `${body}${trailers}`
    : `${body.slice(0, room - 40)}\n\n… (truncated)${trailers}`;
}
