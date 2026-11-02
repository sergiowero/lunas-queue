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

/** One-line `key: value` frontmatter, the form Claude Code subagents use. */
function parseAgent(file: string): { meta: Record<string, string>; body: string } {
  const text = readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: no frontmatter`);
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const sep = line.indexOf(":");
    if (sep <= 0) throw new Error(`${file}: invalid frontmatter line: ${line}`);
    meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { meta, body: match[2] ?? "" };
}

// The same names as `REVIEWER_NAMES` from @lunasq/schemas (docs/design.md §Verification with
// subagents); this package depends on none of them.
const REVIEWERS = [
  "lunasq-security-reviewer",
  "lunasq-ux-reviewer",
  "lunasq-ui-reviewer",
  "lunasq-code-reviewer",
];
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash"];
const reviewersDir = join(root, "lunasq");

describe("@lunasq/assets-agents", () => {
  it("every agents markdown opens with frontmatter", () => {
    for (const file of markdownFiles(root)) {
      expect(readFileSync(file, "utf8").startsWith("---\n"), file).toBe(true);
    }
  });

  it("lunasq/ carries exactly the 4 reviewers, one file per name", () => {
    const files = markdownFiles(reviewersDir);
    expect(files.map((f) => basename(f, ".md")).sort()).toEqual([...REVIEWERS].sort());
    for (const file of files) expect(parseAgent(file).meta.name).toBe(basename(file, ".md"));
  });

  describe.each(REVIEWERS)("%s", (name) => {
    const agent = () => parseAgent(join(reviewersDir, `${name}.md`));

    it("runs on Opus", () => {
      expect(agent().meta.model).toBe("opus");
    });

    it("is read-only: Read, Grep, Glob and Bash, with no editing tools", () => {
      const tools = (agent().meta.tools ?? "").split(",").map((t) => t.trim());
      expect(tools).toEqual(READ_ONLY_TOOLS);
    });

    it("has a description so the approver can choose it", () => {
      expect(agent().meta.description?.length ?? 0).toBeGreaterThan(40);
    });

    it("sets the compact format: severity, file, evidence and criterion, or NO FINDINGS", () => {
      const { body } = agent();
      expect(body).toContain("## Output format");
      expect(body).toContain("[<severity>] <file>[:<line>] · <criterion> · <evidence>");
      expect(body).toContain("NO FINDINGS");
      expect(body).toMatch(/do not edit/i);
    });
  });

  it("the code reviewer carries the test coherence checklist with the reversal test", () => {
    const { body } = parseAgent(join(reviewersDir, "lunasq-code-reviewer.md"));
    expect(body).toContain("## Test coherence checklist");
    expect(body).toMatch(/reversal/i);
  });
});
