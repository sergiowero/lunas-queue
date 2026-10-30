// Los revisores de assets/agents son los que exige el veredicto (`REVIEWER_NAMES`): si uno cambia
// de nombre, el approver no podría reportarlo ni UW-23 encontrarlo en los hooks.
import { readdirSync } from "node:fs";
import { REVIEWER_NAMES } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";

const agentsDir = new URL("../../../../assets/agents/lunasq/", import.meta.url);

describe("revisores instalables", () => {
  it("assets/agents/lunasq trae un archivo por cada nombre de REVIEWER_NAMES", () => {
    const names = readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    expect(names.sort()).toEqual([...REVIEWER_NAMES].sort());
  });
});
