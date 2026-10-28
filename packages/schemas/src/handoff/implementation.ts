import { z } from "zod";
import { CriterionId, checkUnique, FilePath, list, ShortText, Text } from "./common.ts";
import { envelopeShape } from "./envelope.ts";

export const CriterionTests = z.strictObject({
  criterionId: CriterionId,
  tests: list(z.strictObject({ file: FilePath, name: ShortText }), 50).min(1, {
    error: "cada criterio necesita al menos un test",
  }),
});

export const CommitSha = z.string().regex(/^[0-9a-f]{7,40}$/, {
  error: "commit inválido: se esperaba un SHA hexadecimal de 7 a 40 caracteres",
});

export const ImplementationBody = z
  .strictObject({
    criterionTests: list(CriterionTests, 50).min(1),
    commits: list(CommitSha).min(1),
    changesByModule: list(z.strictObject({ module: FilePath, summary: Text }), 50).min(1),
    howToTest: z.strictObject({ commands: list(ShortText, 20).min(1) }),
    specDeviations: list(z.strictObject({ deviation: Text, reason: Text }), 50),
  })
  .superRefine((body, ctx) => {
    checkUnique(
      ctx,
      body.criterionTests,
      (c) => c.criterionId,
      (i) => ["criterionTests", i, "criterionId"],
      "criterio",
    );
  });

export const ImplementationHandoff = z.strictObject({
  ...envelopeShape,
  phase: z.literal("implementation"),
  body: ImplementationBody,
});
