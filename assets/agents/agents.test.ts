import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = import.meta.dirname;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith(".md") && name !== "README.md" ? [path] : [];
  });
}

/** Frontmatter `clave: valor` de una línea, la forma que usan los subagentes de Claude Code. */
function parseAgent(file: string): { meta: Record<string, string>; body: string } {
  const text = readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: sin frontmatter`);
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const sep = line.indexOf(":");
    if (sep <= 0) throw new Error(`${file}: línea de frontmatter inválida: ${line}`);
    meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { meta, body: match[2] ?? "" };
}

// Los mismos nombres que `REVIEWER_NAMES` de @lunasq/schemas (docs/design.md §Verificación con
// subagentes); este paquete no depende de ninguno.
const REVIEWERS = [
  "lunasq-security-reviewer",
  "lunasq-ux-reviewer",
  "lunasq-ui-reviewer",
  "lunasq-code-reviewer",
];
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash"];
const reviewersDir = join(root, "lunasq");

describe("@lunasq/assets-agents", () => {
  it("todo markdown de agents abre con frontmatter", () => {
    for (const file of markdownFiles(root)) {
      expect(readFileSync(file, "utf8").startsWith("---\n"), file).toBe(true);
    }
  });

  it("lunasq/ trae exactamente los 4 revisores, un archivo por nombre", () => {
    const files = markdownFiles(reviewersDir);
    expect(files.map((f) => basename(f, ".md")).sort()).toEqual([...REVIEWERS].sort());
    for (const file of files) expect(parseAgent(file).meta.name).toBe(basename(file, ".md"));
  });

  describe.each(REVIEWERS)("%s", (name) => {
    const agent = () => parseAgent(join(reviewersDir, `${name}.md`));

    it("corre en Opus", () => {
      expect(agent().meta.model).toBe("opus");
    });

    it("es de solo lectura: Read, Grep, Glob y Bash, sin herramientas que editen", () => {
      const tools = (agent().meta.tools ?? "").split(",").map((t) => t.trim());
      expect(tools).toEqual(READ_ONLY_TOOLS);
    });

    it("tiene descripción para que el approver lo elija", () => {
      expect(agent().meta.description?.length ?? 0).toBeGreaterThan(40);
    });

    it("fija el formato compacto: severidad, archivo, evidencia y criterio, o SIN HALLAZGOS", () => {
      const { body } = agent();
      expect(body).toContain("## Formato de salida");
      expect(body).toContain("[<severidad>] <archivo>[:<línea>] · <criterio> · <evidencia>");
      expect(body).toContain("SIN HALLAZGOS");
      expect(body).toMatch(/no edites/i);
    });
  });

  it("el revisor de código lleva el checklist de coherencia de tests con la prueba de reversión", () => {
    const { body } = parseAgent(join(reviewersDir, "lunasq-code-reviewer.md"));
    expect(body).toContain("## Checklist de coherencia de tests");
    expect(body).toMatch(/reversi[óo]n/i);
  });
});
