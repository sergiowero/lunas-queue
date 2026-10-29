// Spec versionada y su aprobación (docs/design.md §Modelo de dominio y §Human-in-the-loop,
// ADR 0013). El contenido es el mismo del handoff de refinamiento, sin los supuestos.
import { z } from "zod";
import { Actor, SpecApproval } from "./enums.ts";
import {
  AcceptanceCriterion,
  Aggregate,
  checkSpecReferences,
  DomainEvent,
  GlossaryEntry,
  SpecTask,
  specContentShape,
} from "./handoff/refinement.ts";

export const SpecContent = z.strictObject(specContentShape).superRefine(checkSpecReferences);
export type SpecContent = z.infer<typeof SpecContent>;

const Version = z.int().min(1);

export const Spec = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  version: Version,
  content: SpecContent,
  approval: SpecApproval,
  // Autor de la versión: el refinador, o el humano que la editó antes de aprobar.
  createdBy: Actor,
  approvedBy: Actor.nullable(),
  approvedAt: z.date().nullable(),
  reviewComments: z.string().nullable(),
  createdAt: z.date(),
});
export type Spec = z.infer<typeof Spec>;

/** Versión en la ruta: entero positivo sin ceros a la izquierda. */
export const SpecVersionParam = z
  .string()
  .regex(/^[1-9]\d{0,8}$/, { error: "versión inválida: se esperaba un entero positivo" })
  .transform(Number);

export const SpecDiffQuery = z.strictObject({ against: SpecVersionParam.optional() });
export type SpecDiffQuery = z.infer<typeof SpecDiffQuery>;

const Comments = z.string().trim().min(1).max(10_000);

export const SpecRequestChanges = z.strictObject({ comments: Comments });
export type SpecRequestChanges = z.infer<typeof SpecRequestChanges>;

export const SpecEditAndApprove = z.strictObject({ content: SpecContent });
export type SpecEditAndApprove = z.infer<typeof SpecEditAndApprove>;

// Diff entre dos versiones. Las listas con id (criterios, tareas, términos, agregados, eventos)
// se comparan por su clave; las de texto, por valor.

function keyedDiff<T extends z.ZodType>(item: T) {
  return z.strictObject({
    added: z.array(item),
    removed: z.array(item),
    changed: z.array(z.strictObject({ key: z.string(), from: item, to: item })),
  });
}

export const TextListDiff = z.strictObject({
  added: z.array(z.string()),
  removed: z.array(z.string()),
});
export type TextListDiff = z.infer<typeof TextListDiff>;

export const SpecContentDiff = z.strictObject({
  domainModel: z.strictObject({
    boundedContext: z.strictObject({ from: z.string(), to: z.string() }).nullable(),
    glossary: keyedDiff(GlossaryEntry),
    aggregates: keyedDiff(Aggregate),
    invariants: TextListDiff,
    events: keyedDiff(DomainEvent),
  }),
  requirements: TextListDiff,
  criteria: keyedDiff(AcceptanceCriterion),
  taskList: keyedDiff(SpecTask),
});
export type SpecContentDiff = z.infer<typeof SpecContentDiff>;

export const SpecDiff = z.strictObject({
  // null cuando `to` es la primera versión: todo aparece como agregado.
  from: Version.nullable(),
  to: Version,
  identical: z.boolean(),
  changes: SpecContentDiff,
});
export type SpecDiff = z.infer<typeof SpecDiff>;

export const SPEC_VERSION_CREATED = "spec.version_created";
export const SPEC_APPROVED = "spec.approved";
export const SPEC_CHANGES_REQUESTED = "spec.changes_requested";

/** El actor del evento es el autor; `basedOn` es la versión que el humano editó. */
export const SpecVersionCreatedPayload = z.strictObject({
  specId: z.uuid(),
  version: Version,
  basedOn: Version.nullable(),
});
export type SpecVersionCreatedPayload = z.infer<typeof SpecVersionCreatedPayload>;

export const SpecApprovedPayload = z.strictObject({ specId: z.uuid(), version: Version });
export type SpecApprovedPayload = z.infer<typeof SpecApprovedPayload>;

export const SpecChangesRequestedPayload = z.strictObject({
  specId: z.uuid(),
  version: Version,
  comments: Comments,
});
export type SpecChangesRequestedPayload = z.infer<typeof SpecChangesRequestedPayload>;
