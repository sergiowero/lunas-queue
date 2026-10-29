import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// El backlog de docs/units-of-work.md y los archivos de estado de docs/units/ describen las
// mismas unidades: cada fila tiene su uw-XX.md y cada archivo un estado válido (ver AGENTS.md).
const root = join(import.meta.dirname, "..");
const unitsDir = join(root, "docs", "units");

const backlogIds = readFileSync(join(root, "docs", "units-of-work.md"), "utf8")
  .split("\n\n")
  .find((block) => block.startsWith("| ID | Unit of work |"))
  ?.split("\n")
  .slice(2)
  .map((row) => row.split("|")[1]?.trim());

describe("estado de las unidades", () => {
  it("hay un archivo por unidad del backlog y ninguno de más", () => {
    const files = readdirSync(unitsDir).sort();
    expect(files).toEqual((backlogIds ?? []).map((id) => `${id?.toLowerCase()}.md`).sort());
  });

  it.each(readdirSync(unitsDir))("%s tiene un estado válido", (file) => {
    const content = readFileSync(join(unitsDir, file), "utf8");
    expect(content).toMatch(/^---\nestado: (Pendiente|Hecho)\n---\n/);
  });
});
