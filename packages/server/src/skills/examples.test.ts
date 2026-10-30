// El handoff de ejemplo de cada skill de fase (assets/skills) pasa `parseHandoff`: si el esquema
// cambia, la skill que copia el agente no se queda atrás. La prueba con Claude Code real está en
// real.integration.test.ts.
import { readFileSync } from "node:fs";
import { parseHandoff } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";

const skillsDir = new URL("../../../../assets/skills/", import.meta.url);

/** Los bloques ```json de la skill: el primero es un handoff completo; los demás, otros cuerpos. */
function jsonBlocks(skill: string): Record<string, unknown>[] {
  const text = readFileSync(new URL(`${skill}/SKILL.md`, skillsDir), "utf8");
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1] ?? ""));
  if (blocks.length === 0) throw new Error(`${skill}: sin bloque json`);
  return blocks;
}

describe("handoff de ejemplo de las skills de fase", () => {
  it.each([
    ["refine-task", "refinement"],
    ["implement-task", "implementation"],
    ["verify-task", "verification"],
  ])("%s trae un handoff %s válido", (skill, phase) => {
    const result = parseHandoff(jsonBlocks(skill)[0]);
    expect(result.success ? [] : result.errors).toEqual([]);
    expect(result.success && result.data.phase).toBe(phase);
  });

  it("verify-task trae también un cuerpo de pass válido con el mismo sobre", () => {
    const [reject, passBody] = jsonBlocks("verify-task");
    const result = parseHandoff({ ...reject, body: passBody });
    expect(result.success ? [] : result.errors).toEqual([]);
    expect(result.success && result.data.phase === "verification" && result.data.body.verdict).toBe(
      "pass",
    );
  });
});
