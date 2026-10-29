import { describe, expect, it } from "vitest";
import {
  SPEC_APPROVED,
  SPEC_CHANGES_REQUESTED,
  SPEC_VERSION_CREATED,
  Spec,
  SpecApprovedPayload,
  SpecChangesRequestedPayload,
  SpecContent,
  SpecDiffQuery,
  SpecEditAndApprove,
  SpecRequestChanges,
  SpecVersionCreatedPayload,
  SpecVersionParam,
} from "./index.ts";
import { specContentExample } from "./testing.ts";

const specId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";

describe("SpecContent", () => {
  it("acepta el contenido de una spec de refinamiento sin supuestos", () => {
    const content = specContentExample();
    expect(SpecContent.parse(content)).toEqual(content);
  });

  it("rechaza los supuestos: van en el handoff, no en la spec", () => {
    expect(SpecContent.safeParse({ ...specContentExample(), assumptions: [] }).success).toBe(false);
  });

  it("exige requerimientos, criterios y task list", () => {
    for (const field of ["requirements", "criteria", "taskList"] as const) {
      const result = SpecContent.safeParse({ ...specContentExample(), [field]: [] });
      expect(result.success, field).toBe(false);
    }
  });

  it("rechaza ids repetidos y tareas que apuntan a criterios inexistentes", () => {
    const content = specContentExample();
    content.criteria.push({ id: "AC-1", given: "otro", when: "otro", outcome: "otro resultado" });
    content.taskList = [{ id: "T-1", title: "Comando", criterionIds: ["AC-9"] }];
    const result = SpecContent.safeParse(content);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual(
      expect.arrayContaining(["criteria.2.id", "taskList.0.criterionIds.0"]),
    );
  });
});

describe("Spec", () => {
  it("describe una versión con su autor y su aprobación", () => {
    const spec = {
      id: specId,
      taskId,
      version: 2,
      content: specContentExample(),
      approval: "approved",
      createdBy: "human",
      approvedBy: "human",
      approvedAt: new Date(),
      reviewComments: null,
      createdAt: new Date(),
    };
    expect(Spec.parse(spec)).toEqual(spec);
    expect(Spec.safeParse({ ...spec, version: 0 }).success).toBe(false);
  });
});

describe("entradas de la API", () => {
  it("SpecVersionParam acepta solo enteros positivos en texto", () => {
    expect(SpecVersionParam.parse("3")).toBe(3);
    for (const bad of ["0", "-1", "1.5", "abc", "01", ""]) {
      expect(SpecVersionParam.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("SpecDiffQuery toma la versión contra la que se compara", () => {
    expect(SpecDiffQuery.parse({})).toEqual({});
    expect(SpecDiffQuery.parse({ against: "1" })).toEqual({ against: 1 });
    expect(SpecDiffQuery.safeParse({ against: "x" }).success).toBe(false);
  });

  it("SpecRequestChanges exige comentarios no vacíos y los recorta", () => {
    expect(SpecRequestChanges.parse({ comments: "  falta un criterio  " })).toEqual({
      comments: "falta un criterio",
    });
    expect(SpecRequestChanges.safeParse({ comments: "   " }).success).toBe(false);
    expect(SpecRequestChanges.safeParse({}).success).toBe(false);
  });

  it("SpecEditAndApprove exige contenido completo", () => {
    const content = specContentExample();
    expect(SpecEditAndApprove.parse({ content })).toEqual({ content });
    expect(SpecEditAndApprove.safeParse({ content: { ...content, criteria: [] } }).success).toBe(
      false,
    );
  });
});

describe("eventos de spec", () => {
  it("tienen nombres estables", () => {
    expect([SPEC_VERSION_CREATED, SPEC_APPROVED, SPEC_CHANGES_REQUESTED]).toEqual([
      "spec.version_created",
      "spec.approved",
      "spec.changes_requested",
    ]);
  });

  it("validan sus payloads", () => {
    expect(SpecVersionCreatedPayload.parse({ specId, version: 2, basedOn: 1 })).toMatchObject({
      version: 2,
      basedOn: 1,
    });
    expect(SpecVersionCreatedPayload.parse({ specId, version: 1, basedOn: null }).basedOn).toBe(
      null,
    );
    expect(SpecApprovedPayload.parse({ specId, version: 1 })).toEqual({ specId, version: 1 });
    expect(
      SpecChangesRequestedPayload.safeParse({ specId, version: 1, comments: "" }).success,
    ).toBe(false);
  });
});
