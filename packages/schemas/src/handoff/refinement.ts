import { z } from "zod";
import { CriterionId, checkUnique, list, ShortText, Text } from "./common.ts";
import { envelopeShape } from "./envelope.ts";

export const DomainModel = z.strictObject({
  boundedContext: ShortText,
  glossary: list(z.strictObject({ term: ShortText, definition: Text })).min(1),
  aggregates: list(z.strictObject({ name: ShortText, entities: list(ShortText, 50) }), 50).min(1),
  invariants: list(Text, 50),
  events: list(z.strictObject({ name: ShortText, description: Text }), 50),
});

export const AcceptanceCriterion = z.strictObject({
  id: CriterionId,
  given: Text,
  when: Text,
  outcome: Text,
});

export const SpecTask = z.strictObject({
  id: z.string().regex(/^T-[1-9]\d*$/, {
    error: "id de tarea inválido: se esperaba T-<n>, por ejemplo T-1",
  }),
  title: ShortText,
  criterionIds: list(CriterionId, 50),
});

export const RefinementBody = z
  .strictObject({
    domainModel: DomainModel,
    criteria: list(AcceptanceCriterion, 50).min(1),
    taskList: list(SpecTask).min(1),
    assumptions: list(Text, 50),
  })
  .superRefine((body, ctx) => {
    checkUnique(
      ctx,
      body.criteria,
      (c) => c.id,
      (i) => ["criteria", i, "id"],
      "id de criterio",
    );
    checkUnique(
      ctx,
      body.taskList,
      (t) => t.id,
      (i) => ["taskList", i, "id"],
      "id de tarea",
    );
    const criterionIds = new Set(body.criteria.map((c) => c.id));
    body.taskList.forEach((task, i) => {
      task.criterionIds.forEach((id, j) => {
        if (!criterionIds.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: ["taskList", i, "criterionIds", j],
            message: `la tarea apunta a un criterio que no existe en la spec: ${id}`,
          });
        }
      });
    });
  });

export const RefinementHandoff = z.strictObject({
  ...envelopeShape,
  phase: z.literal("refinement"),
  body: RefinementBody,
});
