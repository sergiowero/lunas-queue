import { z } from "zod";
import { CriterionId, checkUnique, list, ShortText, Text } from "./common.ts";
import { envelopeShape } from "./envelope.ts";

export const GlossaryEntry = z.strictObject({ term: ShortText, definition: Text });
export const Aggregate = z.strictObject({ name: ShortText, entities: list(ShortText, 50) });
export const DomainEvent = z.strictObject({ name: ShortText, description: Text });

export const DomainModel = z.strictObject({
  boundedContext: ShortText,
  glossary: list(GlossaryEntry).min(1),
  aggregates: list(Aggregate, 50).min(1),
  invariants: list(Text, 50),
  events: list(DomainEvent, 50),
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

// Contenido de una versión de Spec (docs/design.md §Modelo de dominio). La Spec lo guarda tal
// cual; el handoff de refinamiento lo envía junto con los supuestos.
export const specContentShape = {
  domainModel: DomainModel,
  requirements: list(Text, 50).min(1),
  criteria: list(AcceptanceCriterion, 50).min(1),
  taskList: list(SpecTask).min(1),
};

/** Ids únicos y tareas que solo apuntan a criterios de la misma spec. */
export function checkSpecReferences(
  body: { criteria: { id: string }[]; taskList: { id: string; criterionIds: string[] }[] },
  ctx: z.RefinementCtx,
): void {
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
}

export const RefinementBody = z
  .strictObject({ ...specContentShape, assumptions: list(Text, 50) })
  .superRefine(checkSpecReferences);

export const RefinementHandoff = z.strictObject({
  ...envelopeShape,
  phase: z.literal("refinement"),
  body: RefinementBody,
});
