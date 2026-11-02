// The example handoff of each phase skill (assets/skills) passes `parseHandoff`: if the schema
// changes, the skill the agent copies does not fall behind. The test with real Claude Code is in
// real.integration.test.ts.
import { readFileSync } from "node:fs";
import { parseHandoff, parseResultHandoff } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";

const skillsDir = new URL("../../../../assets/skills/", import.meta.url);

/** The ```json blocks of the skill: the first is a complete handoff; the rest, other bodies. */
function jsonBlocks(skill: string): Record<string, unknown>[] {
  const text = readFileSync(new URL(`${skill}/SKILL.md`, skillsDir), "utf8");
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1] ?? ""));
  if (blocks.length === 0) throw new Error(`${skill}: no json block`);
  return blocks;
}

describe("example handoff of the phase skills", () => {
  it.each([
    ["refine-task", "refinement"],
    ["implement-task", "implementation"],
    ["verify-task", "verification"],
  ])("%s carries a valid %s handoff", (skill, phase) => {
    const result = parseHandoff(jsonBlocks(skill)[0]);
    expect(result.success ? [] : result.errors).toEqual([]);
    expect(result.success && result.data.phase).toBe(phase);
  });

  it.each([
    ["refine-task", "refinement"],
    ["implement-task", "implementation"],
  ])("%s carries a valid submit_result %s handoff", (skill, phase) => {
    const example = jsonBlocks(skill).find((block) => "resultKind" in block);
    const result = parseResultHandoff(example);
    expect(result.success ? [] : result.errors).toEqual([]);
    expect(result.success && result.data.phase).toBe(phase);
  });

  it("verify-task also carries a valid pass body with the same envelope", () => {
    const [reject, passBody] = jsonBlocks("verify-task");
    const result = parseHandoff({ ...reject, body: passBody });
    expect(result.success ? [] : result.errors).toEqual([]);
    expect(result.success && result.data.phase === "verification" && result.data.body.verdict).toBe(
      "pass",
    );
  });
});
