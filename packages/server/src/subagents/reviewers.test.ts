// The reviewers in assets/agents are the ones the verdict requires (`REVIEWER_NAMES`): if one is renamed,
// the approver could not report it nor UW-23 find it in the hooks.
import { readdirSync } from "node:fs";
import { REVIEWER_NAMES } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";

const agentsDir = new URL("../../../../assets/agents/lunasq/", import.meta.url);

describe("installable reviewers", () => {
  it("assets/agents/lunasq has one file for each name in REVIEWER_NAMES", () => {
    const names = readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    expect(names.sort()).toEqual([...REVIEWER_NAMES].sort());
  });
});
