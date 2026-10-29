// Diff entre dos versiones de Spec para el gate humano (docs/design.md §Human-in-the-loop,
// ADR 0013). Las listas con clave se comparan por clave y las de texto por valor: el orden no
// cuenta como cambio.
import type { SpecContent, SpecContentDiff, TextListDiff } from "@lunasq/schemas";

type KeyedDiff<T> = { added: T[]; removed: T[]; changed: { key: string; from: T; to: T }[] };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function keyed<T>(before: readonly T[], after: readonly T[], key: (item: T) => string) {
  const previous = new Map(before.map((item) => [key(item), item]));
  const next = new Set(after.map(key));
  const diff: KeyedDiff<T> = { added: [], removed: [], changed: [] };
  for (const item of after) {
    const old = previous.get(key(item));
    if (old === undefined) diff.added.push(item);
    else if (!same(old, item)) diff.changed.push({ key: key(item), from: old, to: item });
  }
  diff.removed = before.filter((item) => !next.has(key(item)));
  return diff;
}

function texts(before: readonly string[], after: readonly string[]): TextListDiff {
  const previous = new Set(before);
  const next = new Set(after);
  return {
    added: after.filter((t) => !previous.has(t)),
    removed: before.filter((t) => !next.has(t)),
  };
}

/** Cambios de `before` a `after`; con `before` null todo aparece como agregado. */
export function diffSpecContent(before: SpecContent | null, after: SpecContent): SpecContentDiff {
  const a = before?.domainModel;
  const b = after.domainModel;
  const boundedContext = a?.boundedContext ?? "";
  return {
    domainModel: {
      boundedContext:
        boundedContext === b.boundedContext ? null : { from: boundedContext, to: b.boundedContext },
      glossary: keyed(a?.glossary ?? [], b.glossary, (g) => g.term),
      aggregates: keyed(a?.aggregates ?? [], b.aggregates, (g) => g.name),
      invariants: texts(a?.invariants ?? [], b.invariants),
      events: keyed(a?.events ?? [], b.events, (e) => e.name),
    },
    requirements: texts(before?.requirements ?? [], after.requirements),
    criteria: keyed(before?.criteria ?? [], after.criteria, (c) => c.id),
    taskList: keyed(before?.taskList ?? [], after.taskList, (t) => t.id),
  };
}

export function isEmptyDiff(diff: SpecContentDiff): boolean {
  const { boundedContext, ...lists } = diff.domainModel;
  const all = [...Object.values(lists), diff.requirements, diff.criteria, diff.taskList];
  return boundedContext === null && all.every((d) => Object.values(d).every((v) => v.length === 0));
}
