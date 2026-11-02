// Rules of the verification verdict (docs/design.md §Verification with subagents, ADR
// uw-23-verificacion): what the approver reports for each reviewer must match what the
// SubagentStart and SubagentStop hooks recorded in the Run. Reading those records belongs to db.
import { type HandoffError, REVIEWER_NAMES, type VerificationBody } from "@lunasq/schemas";

/** A subagent execution recorded by the Run's hooks. */
export interface SubagentEvidence {
  agentType: string;
  startedAt: Date | null;
  stoppedAt: Date | null;
}

/**
 * Verdict errors against the hooks; empty if it adds up. A `ran` reviewer must have at least
 * one finished execution; a `skipped` one cannot have it, because the approver would discard its
 * report. A must-fix or a refuted one cannot come from a skipped reviewer.
 */
export function checkReviewerEvidence(
  body: VerificationBody,
  subagents: readonly SubagentEvidence[],
): HandoffError[] {
  const issues: HandoffError[] = [];
  const runsOf = (name: string) => subagents.filter((s) => s.agentType === name);
  for (const name of REVIEWER_NAMES) {
    const report = body.reviewers[name];
    const runs = runsOf(name);
    const done = runs.some((s) => s.stoppedAt !== null);
    const path = `body.reviewers.${name}`;
    if (report.status === "ran" && !done) {
      issues.push({
        path,
        message:
          runs.length === 0
            ? `${name} is reported as run but does not appear in the Run's hooks`
            : `${name} is reported as run but did not finish (no SubagentStop)`,
      });
    }
    if (report.status === "skipped" && done) {
      issues.push({
        path,
        message: `${name} ran and finished in this Run but is reported as skipped: include its report`,
      });
    }
  }

  const skipped = (source: string) =>
    REVIEWER_NAMES.some((name) => name === source && body.reviewers[name].status === "skipped");
  body.mustFix.forEach((f, i) => {
    if (skipped(f.source)) {
      issues.push({ path: `body.mustFix[${i}].source`, message: omittedSource(f.source) });
    }
  });
  body.refuted.forEach((r, i) => {
    if (skipped(r.source)) {
      issues.push({ path: `body.refuted[${i}].source`, message: omittedSource(r.source) });
    }
  });
  return issues;
}

const omittedSource = (name: string) =>
  `the finding is attributed to ${name}, which is reported as skipped`;
