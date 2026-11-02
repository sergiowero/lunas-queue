import { z } from "zod";
import { RiskLabel } from "../enums.ts";
import { CriterionId, checkUnique, FilePath, list, Text } from "./common.ts";
import { envelopeShape } from "./envelope.ts";

export const Finding = z.strictObject({
  severity: z.enum(["critical", "major", "minor"]),
  file: FilePath,
  line: z.int().positive().optional(),
  evidence: Text,
  criterionId: CriterionId.optional(),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewerReport = z.discriminatedUnion(
  "status",
  [
    z.strictObject({ status: z.literal("ran"), findings: list(Finding) }),
    z.strictObject({ status: z.literal("skipped"), justification: Text }),
  ],
  {
    error: (issue) => {
      if (issue.input === undefined) {
        return "the reviewer's report or the justification for why it was not launched is missing";
      }
      return issue.code === "invalid_union"
        ? "invalid reviewer status: ran or skipped expected"
        : undefined;
    },
  },
);

// The 4 reviewers of the verification phase; each one reports or is skipped with a justification.
export const Reviewers = z.strictObject({
  "lunasq-security-reviewer": ReviewerReport,
  "lunasq-ux-reviewer": ReviewerReport,
  "lunasq-ui-reviewer": ReviewerReport,
  "lunasq-code-reviewer": ReviewerReport,
});
export const REVIEWER_NAMES = Reviewers.keyof().options;
export type ReviewerName = (typeof REVIEWER_NAMES)[number];

// Who originated a consolidated finding: a reviewer or the approver itself.
export const FindingSource = z.enum([...REVIEWER_NAMES, "approver"]);

// A finding the implementer must fix, with the reviewer (or the approver) that originated it.
export const MustFixFinding = Finding.extend({ source: FindingSource });
export type MustFixFinding = z.infer<typeof MustFixFinding>;

export const VerificationBody = z
  .strictObject({
    verdict: z.enum(["pass", "reject"]),
    criteriaVerdicts: list(
      z.strictObject({
        criterionId: CriterionId,
        verdict: z.enum(["pass", "fail"]),
        evidence: Text,
      }),
      50,
    ).min(1),
    reviewers: Reviewers,
    mustFix: list(MustFixFinding),
    refuted: list(z.strictObject({ finding: Finding, reason: Text, source: FindingSource })),
    riskLabel: RiskLabel,
  })
  .superRefine((body, ctx) => {
    checkUnique(
      ctx,
      body.criteriaVerdicts,
      (c) => c.criterionId,
      (i) => ["criteriaVerdicts", i, "criterionId"],
      "criterion verdict",
    );
    if (body.verdict === "pass") {
      body.criteriaVerdicts.forEach((c, i) => {
        if (c.verdict === "fail") {
          ctx.addIssue({
            code: "custom",
            path: ["criteriaVerdicts", i, "verdict"],
            message: `a pass verdict requires all criteria to pass; ${c.criterionId} fails`,
          });
        }
      });
      if (body.mustFix.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["mustFix"],
          message: "a pass verdict does not allow pending must-fix findings",
        });
      }
    } else if (body.mustFix.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["mustFix"],
        message: "a reject verdict requires at least one must-fix with its evidence",
      });
    }
  });

export type VerificationBody = z.infer<typeof VerificationBody>;

export const VerificationHandoff = z.strictObject({
  ...envelopeShape,
  phase: z.literal("verification"),
  body: VerificationBody,
});
