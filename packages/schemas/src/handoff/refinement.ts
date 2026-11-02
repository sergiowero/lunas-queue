import { z } from "zod";
import { TaskTitle } from "../task.ts";
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
    error: "invalid task id: T-<n> expected, for example T-1",
  }),
  title: ShortText,
  criterionIds: list(CriterionId, 50),
});

export const SpecDeliverable = z.enum(["code", "docs"]);

// Content of a Spec version (docs/design.md §Domain model). The Spec stores it as
// is; the refinement handoff sends it together with the assumptions.
export const specContentShape = {
  /** Repository change the human is approving; omitted in older handoffs means code. */
  deliverable: SpecDeliverable.default("code"),
  domainModel: DomainModel,
  requirements: list(Text, 50).min(1),
  criteria: list(AcceptanceCriterion, 50).min(1),
  taskList: list(SpecTask).min(1),
};

/**
 * Unique ids and names (the diff between versions compares by those keys) and tasks that only
 * point to criteria of the same spec.
 */
export function checkSpecReferences(
  body: {
    domainModel: z.infer<typeof DomainModel>;
    criteria: { id: string }[];
    taskList: { id: string; criterionIds: string[] }[];
  },
  ctx: z.RefinementCtx,
): void {
  const { glossary, aggregates, events } = body.domainModel;
  checkUnique(
    ctx,
    glossary,
    (g) => g.term,
    (i) => ["domainModel", "glossary", i, "term"],
    "glossary term",
  );
  checkUnique(
    ctx,
    aggregates,
    (a) => a.name,
    (i) => ["domainModel", "aggregates", i, "name"],
    "aggregate",
  );
  checkUnique(
    ctx,
    events,
    (e) => e.name,
    (i) => ["domainModel", "events", i, "name"],
    "domain event",
  );
  checkUnique(
    ctx,
    body.criteria,
    (c) => c.id,
    (i) => ["criteria", i, "id"],
    "criterion id",
  );
  checkUnique(
    ctx,
    body.taskList,
    (t) => t.id,
    (i) => ["taskList", i, "id"],
    "task id",
  );
  const criterionIds = new Set(body.criteria.map((c) => c.id));
  body.taskList.forEach((task, i) => {
    task.criterionIds.forEach((id, j) => {
      if (!criterionIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["taskList", i, "criterionIds", j],
          message: `the task points to a criterion that does not exist in the spec: ${id}`,
        });
      }
    });
  });
}

export const RefinementBody = z
  // `title` is only saved in the first refinement of the task (docs/design.md §Domain model).
  .strictObject({ title: TaskTitle, ...specContentShape, assumptions: list(Text, 50) })
  .superRefine(checkSpecReferences);

export const RefinementHandoff = z.strictObject({
  ...envelopeShape,
  phase: z.literal("refinement"),
  body: RefinementBody,
});
