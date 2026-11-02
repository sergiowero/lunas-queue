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

/** One-line `key: value` frontmatter, the form Claude Code skills use. */
function parseSkill(name: string): { meta: Record<string, string>; body: string } {
  const file = join(root, name, "SKILL.md");
  const text = readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: no frontmatter`);
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const sep = line.indexOf(":");
    if (sep <= 0) throw new Error(`${file}: invalid frontmatter line: ${line}`);
    const value = line.slice(sep + 1).trim();
    // Without quotes, `: ` or ` #` inside the value break the YAML Claude Code reads.
    if (value.includes(": ") || value.includes(" #")) {
      throw new Error(`${file}: frontmatter value that is not plain YAML: ${line}`);
    }
    meta[line.slice(0, sep).trim()] = value;
  }
  return { meta, body: match[2] ?? "" };
}

/** The skill's first ```json block: the example handoff. */
function handoffExample(body: string): Record<string, unknown> & { body: Record<string, unknown> } {
  const match = /```json\n([\s\S]*?)\n```/.exec(body);
  if (!match) throw new Error("the skill carries no json block with the handoff");
  return JSON.parse(match[1] ?? "");
}

// The same names as `REVIEWER_NAMES` from @lunasq/schemas, and the keys of the envelope and of each
// v1 handoff body (ADR 0006); this package depends on none of them. The full validation of the
// example with `parseHandoff` lives in packages/server/src/skills/.
const REVIEWERS = [
  "lunasq-security-reviewer",
  "lunasq-ux-reviewer",
  "lunasq-ui-reviewer",
  "lunasq-code-reviewer",
];
const ENVELOPE = [
  "schemaVersion",
  "taskId",
  "runId",
  "phase",
  "result",
  "summary",
  "relevantFiles",
  "decisions",
  "knownRisks",
  "body",
];
const EXIT_TOOLS = ["submit_spec", "submit_for_verification", "submit_verdict"];

const PHASES = [
  {
    skill: "refine-task",
    exit: "submit_spec",
    handoffPhase: "refinement",
    body: ["title", "domainModel", "requirements", "criteria", "taskList", "assumptions"],
  },
  {
    skill: "implement-task",
    exit: "submit_for_verification",
    handoffPhase: "implementation",
    body: ["criterionTests", "commits", "changesByModule", "howToTest", "specDeviations"],
  },
  {
    skill: "verify-task",
    exit: "submit_verdict",
    handoffPhase: "verification",
    body: ["verdict", "criteriaVerdicts", "reviewers", "mustFix", "refuted", "riskLabel"],
  },
] as const;

describe("@lunasq/assets-skills", () => {
  it("every skills markdown opens with frontmatter", () => {
    for (const file of markdownFiles(root)) {
      expect(readFileSync(file, "utf8").startsWith("---\n"), file).toBe(true);
    }
  });

  it("carries exactly the 3 phase skills LunasQ dispatches, a folder with SKILL.md", () => {
    const dirs = readdirSync(root).filter(
      (name) => name !== "node_modules" && statSync(join(root, name)).isDirectory(),
    );
    expect(dirs.sort()).toEqual(PHASES.map((p) => p.skill).sort());
  });

  describe.each(PHASES)("$skill", ({ skill, exit, handoffPhase, body: bodyKeys }) => {
    const parsed = () => parseSkill(skill);

    it("its name is the folder's, the one the phase prompt cites", () => {
      expect(parsed().meta.name).toBe(skill);
    });

    it("has a description so Claude Code can choose it", () => {
      expect(parsed().meta.description?.length ?? 0).toBeGreaterThan(60);
    });

    it("starts with get_task_context and ends with its exit tool, without those of other phases", () => {
      const { body } = parsed();
      expect(body).toContain("get_task_context");
      expect(body).toContain("context_required");
      expect(body).toContain(exit);
      for (const other of EXIT_TOOLS.filter((t) => t !== exit)) expect(body).not.toContain(other);
    });

    it("carries an example handoff with the common envelope and its phase body", () => {
      const example = handoffExample(parsed().body);
      expect(Object.keys(example).sort()).toEqual([...ENVELOPE].sort());
      expect(example.schemaVersion).toBe(1);
      expect(example.phase).toBe(handoffPhase);
      expect(Object.keys(example.body).sort()).toEqual([...bodyKeys].sort());
    });

    it("explains how to fix a rejection in the same Run", () => {
      const { body } = parsed();
      for (const code of ["invalid_handoff", "handoff_mismatch", "tool_not_allowed"]) {
        expect(body, code).toContain(code);
      }
      expect(body).toMatch(/same Run/);
    });

    it("says that invalid_run_token after the exit tool means the phase already closed", () => {
      const { body } = parsed();
      expect(body).toContain("invalid_run_token");
      expect(body).toMatch(/phase has already ended/);
    });

    it("covers ask_human and report_failure", () => {
      const { body } = parsed();
      expect(body).toContain("ask_human");
      expect(body).toContain("report_failure");
      expect(body).toMatch(/end your turn/i);
    });

    it("explains when and how to send options in ask_human", () => {
      const { body } = parsed();
      expect(body).toContain("options");
      expect(body).toMatch(/2 to 6/);
      expect(body).toMatch(/label/);
      expect(body).toMatch(/otra respuesta/i);
    });

    it("asks to use engram only if available, at each point of the design", () => {
      const { body } = parsed();
      expect(body).toContain("## Memory with engram (optional)");
      for (const piece of [
        "mem_context",
        "mem_search",
        "1 or 2 terms",
        "mem_session_summary",
        "superseded",
        "needs_review",
      ]) {
        expect(body, piece).toContain(piece);
      }
      expect(body).toMatch(/if it is not available/i);
      expect(body).toMatch(/mem_session_summary[^\n]*before the exit tool/);
    });
  });

  it("refine-task models with DDD and writes Given / When / Then criteria", () => {
    const { body } = parseSkill("refine-task");
    for (const piece of [
      "bounded context",
      "glossary",
      "aggregates",
      "invariants",
      "domain events",
      "Given / When / Then",
      "changesRequested",
      "topic_key",
    ]) {
      expect(body, piece).toContain(piece);
    }
    expect(body).toMatch(/do not write code/i);
  });

  it.each([
    ["refine-task", ["submit_result", "research", "already_implemented", "not_resolvable"]],
    [
      "implement-task",
      ["submit_result", "branch_has_commits", "already_implemented", "not_resolvable"],
    ],
  ])("%s explains when to close a task without code with submit_result", (skill, pieces) => {
    const { body } = parseSkill(skill);
    for (const piece of pieces) expect(body, piece).toContain(piece);
    expect(body).toMatch(/without (verification|PR)/i);
  });

  it("implement-task follows TDD, checks off the checklist and delivers commits on a clean worktree", () => {
    const { body } = parseSkill("implement-task");
    for (const piece of [
      "update_checklist",
      "failing test",
      "minimal implementation",
      "refactor",
      "criterionTests",
      "rework",
      "mustFix",
      "knownRisks",
      "dirty_worktree",
      "commits_missing",
      "test_gate_failed",
      "spec_mismatch",
      "no_approved_spec",
      "learning",
      "merge-base origin/",
      "deliveryConflict",
    ]) {
      expect(body, piece).toContain(piece);
    }
  });

  it("verify-task chooses reviewers and only reports completed MCP executions", () => {
    const { body } = parseSkill("verify-task");
    for (const reviewer of REVIEWERS) expect(body, reviewer).toContain(reviewer);
    expect(body).toMatch(/You decide on each task which ones to launch/);
    expect(body).toMatch(/reporting them is not launching them/);
    expect(body).toMatch(/run_reviewer/);
    expect(body).toMatch(/completed execution and a received response/);
    expect(parseSkill("verify-task").meta.description).not.toMatch(/launch the 4/);
    expect(body).toMatch(/do not edit/i);
    for (const piece of [
      "justification",
      "reversal test",
      "git stash",
      "refuted",
      "riskLabel",
      "spec_mismatch",
      "head_changed",
      "dirty_worktree",
      "test_gate_failed",
      "verdict_already_recorded",
      "learning",
      "merge-base origin/",
      "criterionTests",
      "returns to your `mustFix`",
    ]) {
      expect(body, piece).toContain(piece);
    }
  });

  it("verify-task also carries the body of a pass", () => {
    const blocks = [...parseSkill("verify-task").body.matchAll(/```json\n([\s\S]*?)\n```/g)];
    const pass = JSON.parse(blocks[1]?.[1] ?? "{}");
    expect(pass.verdict).toBe("pass");
    expect(pass.mustFix).toEqual([]);
    expect(Object.keys(pass.reviewers).sort()).toEqual([...REVIEWERS].sort());
  });

  it("verify-task carries the design's test coherence checklist", () => {
    const { body } = parseSkill("verify-task");
    for (const piece of [
      "at least one test",
      "observable behavior",
      "skipped tests",
      "trivial assertions",
      "invariants",
      "was weakened",
    ]) {
      expect(body, piece).toContain(piece);
    }
  });
});
