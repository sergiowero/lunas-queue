import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

describe("@lunasq/assets-agents", () => {
  it("todo markdown de agents abre con frontmatter", () => {
    for (const file of markdownFiles(root)) {
      expect(readFileSync(file, "utf8").startsWith("---\n"), file).toBe(true);
    }
  });
});
