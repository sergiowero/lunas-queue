import type { SpecContent } from "@lunasq/schemas";
import { specContentExample } from "@lunasq/schemas/testing";
import { describe, expect, it } from "vitest";
import { diffSpecContent, isEmptyDiff } from "./spec-diff.ts";

describe("diffSpecContent", () => {
  it("dos versiones iguales no tienen cambios", () => {
    const diff = diffSpecContent(specContentExample(), specContentExample());
    expect(isEmptyDiff(diff)).toBe(true);
    expect(diff.criteria).toEqual({ added: [], removed: [], changed: [] });
    expect(diff.domainModel.boundedContext).toBeNull();
  });

  it("criterios y tareas se comparan por id: agregados, quitados y cambiados", () => {
    const before = specContentExample();
    const after = specContentExample();
    const [ac1, ac2] = before.criteria;
    after.criteria = [
      {
        id: "AC-1",
        given: "un pedido pendiente",
        when: "el cliente lo cancela",
        outcome: "el pedido queda cancelado",
      },
      { id: "AC-3", given: "un pedido", when: "pasa algo", outcome: "otra cosa" },
    ];
    after.taskList = [
      { id: "T-1", title: "Comando CancelOrder en el agregado", criterionIds: ["AC-1"] },
      { id: "T-2", title: "Vista", criterionIds: ["AC-3"] },
    ];
    const diff = diffSpecContent(before, after);
    expect(isEmptyDiff(diff)).toBe(false);
    expect(diff.criteria).toEqual({
      added: [after.criteria[1]],
      removed: [ac2],
      changed: [{ key: "AC-1", from: ac1, to: after.criteria[0] }],
    });
    expect(diff.taskList.added.map((t) => t.id)).toEqual(["T-2"]);
    expect(diff.taskList.changed.map((c) => c.key)).toEqual(["T-1"]);
    expect(diff.taskList.removed).toEqual([]);
  });

  it("los requerimientos e invariantes se comparan por texto", () => {
    const before = specContentExample();
    const after = specContentExample();
    after.requirements = [...before.requirements.slice(1), "Nuevo requerimiento"];
    after.domainModel.invariants = [];
    const diff = diffSpecContent(before, after);
    expect(diff.requirements).toEqual({
      added: ["Nuevo requerimiento"],
      removed: [before.requirements[0]],
    });
    expect(diff.domainModel.invariants).toEqual({
      added: [],
      removed: before.domainModel.invariants,
    });
  });

  it("reordenar no es un cambio", () => {
    const before = specContentExample();
    const after = specContentExample();
    after.requirements.reverse();
    after.criteria.reverse();
    expect(isEmptyDiff(diffSpecContent(before, after))).toBe(true);
  });

  it("el modelo de dominio se compara por campo y por clave", () => {
    const before = specContentExample();
    const after = specContentExample();
    after.domainModel.boundedContext = "Facturación";
    after.domainModel.glossary = [{ term: "Pedido pendiente", definition: "Otra definición" }];
    after.domainModel.aggregates.push({ name: "Invoice", entities: [] });
    after.domainModel.events = [];
    const { domainModel } = diffSpecContent(before, after);
    expect(domainModel.boundedContext).toEqual({ from: "Pedidos", to: "Facturación" });
    expect(domainModel.glossary.changed.map((c) => c.key)).toEqual(["Pedido pendiente"]);
    expect(domainModel.aggregates.added).toEqual([{ name: "Invoice", entities: [] }]);
    expect(domainModel.events.removed).toEqual(before.domainModel.events);
  });

  it("sin versión anterior todo aparece como agregado", () => {
    const after: SpecContent = specContentExample();
    const diff = diffSpecContent(null, after);
    expect(diff.criteria.added).toEqual(after.criteria);
    expect(diff.requirements.added).toEqual(after.requirements);
    expect(diff.domainModel.boundedContext).toEqual({ from: "", to: "Pedidos" });
    expect(diff.domainModel.glossary.added).toEqual(after.domainModel.glossary);
  });
});
