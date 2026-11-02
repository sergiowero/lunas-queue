import type { SpecContent } from "@lunasq/schemas";
import { specContentExample } from "@lunasq/schemas/testing";
import { describe, expect, it } from "vitest";
import { diffSpecContent, isEmptyDiff } from "./spec-diff.ts";

describe("diffSpecContent", () => {
  it("two identical versions have no changes", () => {
    const diff = diffSpecContent(specContentExample(), specContentExample());
    expect(isEmptyDiff(diff)).toBe(true);
    expect(diff.criteria).toEqual({ added: [], removed: [], changed: [] });
    expect(diff.domainModel.boundedContext).toBeNull();
  });

  it("criteria and tasks are compared by id: added, removed and changed", () => {
    const before = specContentExample();
    const after = specContentExample();
    const [ac1, ac2] = before.criteria;
    after.criteria = [
      {
        id: "AC-1",
        given: "a pending order",
        when: "the customer cancels it",
        outcome: "the order ends up cancelled",
      },
      { id: "AC-3", given: "an order", when: "something happens", outcome: "something else" },
    ];
    after.taskList = [
      { id: "T-1", title: "CancelOrder command on the aggregate", criterionIds: ["AC-1"] },
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

  it("requirements and invariants are compared by text", () => {
    const before = specContentExample();
    const after = specContentExample();
    after.requirements = [...before.requirements.slice(1), "New requirement"];
    after.domainModel.invariants = [];
    const diff = diffSpecContent(before, after);
    expect(diff.requirements).toEqual({
      added: ["New requirement"],
      removed: [before.requirements[0]],
    });
    expect(diff.domainModel.invariants).toEqual({
      added: [],
      removed: before.domainModel.invariants,
    });
  });

  it("reordering is not a change", () => {
    const before = specContentExample();
    const after = specContentExample();
    after.requirements.reverse();
    after.criteria.reverse();
    expect(isEmptyDiff(diffSpecContent(before, after))).toBe(true);
  });

  it("the domain model is compared by field and by key", () => {
    const before = specContentExample();
    const after = specContentExample();
    after.domainModel.boundedContext = "Billing";
    after.domainModel.glossary = [{ term: "Pending order", definition: "Another definition" }];
    after.domainModel.aggregates.push({ name: "Invoice", entities: [] });
    after.domainModel.events = [];
    const { domainModel } = diffSpecContent(before, after);
    expect(domainModel.boundedContext).toEqual({ from: "Orders", to: "Billing" });
    expect(domainModel.glossary.changed.map((c) => c.key)).toEqual(["Pending order"]);
    expect(domainModel.aggregates.added).toEqual([{ name: "Invoice", entities: [] }]);
    expect(domainModel.events.removed).toEqual(before.domainModel.events);
  });

  it("without a previous version everything appears as added", () => {
    const after: SpecContent = specContentExample();
    const diff = diffSpecContent(null, after);
    expect(diff.criteria.added).toEqual(after.criteria);
    expect(diff.requirements.added).toEqual(after.requirements);
    expect(diff.domainModel.boundedContext).toEqual({ from: "", to: "Orders" });
    expect(diff.domainModel.glossary.added).toEqual(after.domainModel.glossary);
  });
});
