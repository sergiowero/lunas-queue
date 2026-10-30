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
        return "falta el reporte del revisor o la justificación de por qué no se lanzó";
      }
      return issue.code === "invalid_union"
        ? "estado de revisor inválido: se esperaba ran o skipped"
        : undefined;
    },
  },
);

// Los 4 revisores de la fase de verificación; cada uno reporta o queda omitido con justificación.
export const Reviewers = z.strictObject({
  "lunasq-security-reviewer": ReviewerReport,
  "lunasq-ux-reviewer": ReviewerReport,
  "lunasq-ui-reviewer": ReviewerReport,
  "lunasq-code-reviewer": ReviewerReport,
});
export const REVIEWER_NAMES = Reviewers.keyof().options;
export type ReviewerName = (typeof REVIEWER_NAMES)[number];

// Quién originó un hallazgo consolidado: un revisor o el propio approver.
export const FindingSource = z.enum([...REVIEWER_NAMES, "approver"]);

// Hallazgo que el implementador debe corregir, con el revisor (o el approver) que lo originó.
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
      "veredicto de criterio",
    );
    if (body.verdict === "pass") {
      body.criteriaVerdicts.forEach((c, i) => {
        if (c.verdict === "fail") {
          ctx.addIssue({
            code: "custom",
            path: ["criteriaVerdicts", i, "verdict"],
            message: `un veredicto pass exige que todos los criterios pasen; ${c.criterionId} falla`,
          });
        }
      });
      if (body.mustFix.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["mustFix"],
          message: "un veredicto pass no admite must-fix pendientes",
        });
      }
    } else if (body.mustFix.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["mustFix"],
        message: "un veredicto reject exige al menos un must-fix con su evidencia",
      });
    }
  });

export type VerificationBody = z.infer<typeof VerificationBody>;

export const VerificationHandoff = z.strictObject({
  ...envelopeShape,
  phase: z.literal("verification"),
  body: VerificationBody,
});
