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
  it("accepts the content of a refinement spec without assumptions", () => {
    const content = specContentExample();
    expect(SpecContent.parse(content)).toEqual(content);
  });

  it("rejects the assumptions: they go in the handoff, not in the spec", () => {
    expect(SpecContent.safeParse({ ...specContentExample(), assumptions: [] }).success).toBe(false);
  });

  it("requires requirements, criteria and task list", () => {
    for (const field of ["requirements", "criteria", "taskList"] as const) {
      const result = SpecContent.safeParse({ ...specContentExample(), [field]: [] });
      expect(result.success, field).toBe(false);
    }
  });

  it("rejects repeated terms, aggregates and events: the diff compares by those keys", () => {
    const content = specContentExample();
    const { glossary, aggregates, events } = content.domainModel;
    content.domainModel.glossary = [...glossary, ...glossary];
    content.domainModel.aggregates = [...aggregates, ...aggregates];
    content.domainModel.events = [...events, ...events];
    const result = SpecContent.safeParse(content);
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual([
      "domainModel.glossary.1.term",
      "domainModel.aggregates.1.name",
      "domainModel.events.1.name",
    ]);
  });

  it("rejects repeated ids and tasks that point to nonexistent criteria", () => {
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
  it("describes a version with its author and its approval", () => {
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

describe("API inputs", () => {
  it("SpecVersionParam accepts only positive integers as text", () => {
    expect(SpecVersionParam.parse("3")).toBe(3);
    for (const bad of ["0", "-1", "1.5", "abc", "01", ""]) {
      expect(SpecVersionParam.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("SpecDiffQuery takes the version to compare against", () => {
    expect(SpecDiffQuery.parse({})).toEqual({});
    expect(SpecDiffQuery.parse({ against: "1" })).toEqual({ against: 1 });
    expect(SpecDiffQuery.safeParse({ against: "x" }).success).toBe(false);
  });

  it("SpecRequestChanges requires non-empty comments and trims them", () => {
    expect(SpecRequestChanges.parse({ comments: "  falta un criterio  " })).toEqual({
      comments: "falta un criterio",
    });
    expect(SpecRequestChanges.safeParse({ comments: "   " }).success).toBe(false);
    expect(SpecRequestChanges.safeParse({}).success).toBe(false);
  });

  it("SpecEditAndApprove requires complete content", () => {
    const content = specContentExample();
    expect(SpecEditAndApprove.parse({ content })).toEqual({ content });
    expect(SpecEditAndApprove.safeParse({ content: { ...content, criteria: [] } }).success).toBe(
      false,
    );
  });
});

describe("spec events", () => {
  it("have stable names", () => {
    expect([SPEC_VERSION_CREATED, SPEC_APPROVED, SPEC_CHANGES_REQUESTED]).toEqual([
      "spec.version_created",
      "spec.approved",
      "spec.changes_requested",
    ]);
  });

  it("validate their payloads", () => {
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
