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

/** Frontmatter `clave: valor` de una línea, la forma que usan las skills de Claude Code. */
function parseSkill(name: string): { meta: Record<string, string>; body: string } {
  const file = join(root, name, "SKILL.md");
  const text = readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: sin frontmatter`);
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const sep = line.indexOf(":");
    if (sep <= 0) throw new Error(`${file}: línea de frontmatter inválida: ${line}`);
    const value = line.slice(sep + 1).trim();
    // Sin comillas, `: ` o ` #` dentro del valor rompen el YAML que lee Claude Code.
    if (value.includes(": ") || value.includes(" #")) {
      throw new Error(`${file}: valor de frontmatter que no es YAML plano: ${line}`);
    }
    meta[line.slice(0, sep).trim()] = value;
  }
  return { meta, body: match[2] ?? "" };
}

/** El primer bloque ```json de la skill: el handoff de ejemplo. */
function handoffExample(body: string): Record<string, unknown> & { body: Record<string, unknown> } {
  const match = /```json\n([\s\S]*?)\n```/.exec(body);
  if (!match) throw new Error("la skill no trae un bloque json con el handoff");
  return JSON.parse(match[1] ?? "");
}

// Los mismos nombres que `REVIEWER_NAMES` de @lunasq/schemas, y las claves del sobre y de cada
// cuerpo del handoff v1 (ADR 0006); este paquete no depende de ninguno. La validación completa del
// ejemplo con `parseHandoff` vive en packages/server/src/skills/.
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
  it("todo markdown de skills abre con frontmatter", () => {
    for (const file of markdownFiles(root)) {
      expect(readFileSync(file, "utf8").startsWith("---\n"), file).toBe(true);
    }
  });

  it("trae exactamente las 3 skills de fase que despacha LunasQ, una carpeta con SKILL.md", () => {
    const dirs = readdirSync(root).filter(
      (name) => name !== "node_modules" && statSync(join(root, name)).isDirectory(),
    );
    expect(dirs.sort()).toEqual(PHASES.map((p) => p.skill).sort());
  });

  describe.each(PHASES)("$skill", ({ skill, exit, handoffPhase, body: bodyKeys }) => {
    const parsed = () => parseSkill(skill);

    it("su name es el de la carpeta, el que cita el prompt de fase", () => {
      expect(parsed().meta.name).toBe(skill);
    });

    it("tiene descripción para que Claude Code la elija", () => {
      expect(parsed().meta.description?.length ?? 0).toBeGreaterThan(60);
    });

    it("empieza por get_task_context y termina con su tool de salida, sin las de otras fases", () => {
      const { body } = parsed();
      expect(body).toContain("get_task_context");
      expect(body).toContain("context_required");
      expect(body).toContain(exit);
      for (const other of EXIT_TOOLS.filter((t) => t !== exit)) expect(body).not.toContain(other);
    });

    it("trae un handoff de ejemplo con el sobre común y el cuerpo de su fase", () => {
      const example = handoffExample(parsed().body);
      expect(Object.keys(example).sort()).toEqual([...ENVELOPE].sort());
      expect(example.schemaVersion).toBe(1);
      expect(example.phase).toBe(handoffPhase);
      expect(Object.keys(example.body).sort()).toEqual([...bodyKeys].sort());
    });

    it("explica cómo corregir un rechazo en el mismo Run", () => {
      const { body } = parsed();
      for (const code of ["invalid_handoff", "handoff_mismatch", "tool_not_allowed"]) {
        expect(body, code).toContain(code);
      }
      expect(body).toMatch(/mismo Run/);
    });

    it("dice que invalid_run_token tras la tool de salida significa que la fase ya cerró", () => {
      const { body } = parsed();
      expect(body).toContain("invalid_run_token");
      expect(body).toMatch(/fase ya (terminó|cerró)/);
    });

    it("cubre ask_human y report_failure", () => {
      const { body } = parsed();
      expect(body).toContain("ask_human");
      expect(body).toContain("report_failure");
      expect(body).toMatch(/termina tu turno/i);
    });

    it("pide usar engram solo si está disponible, en cada momento del diseño", () => {
      const { body } = parsed();
      expect(body).toContain("## Memoria con engram (opcional)");
      for (const piece of [
        "mem_context",
        "mem_search",
        "1 o 2 términos",
        "mem_session_summary",
        "superseded",
        "needs_review",
      ]) {
        expect(body, piece).toContain(piece);
      }
      expect(body).toMatch(/si no está disponible/i);
      expect(body).toMatch(/mem_session_summary[^\n]*antes de la tool de salida/);
    });
  });

  it("refine-task modela con DDD y escribe criterios Given / When / Then", () => {
    const { body } = parseSkill("refine-task");
    for (const piece of [
      "bounded context",
      "glosario",
      "agregados",
      "invariantes",
      "eventos de dominio",
      "Given / When / Then",
      "changesRequested",
      "topic_key",
    ]) {
      expect(body, piece).toContain(piece);
    }
    expect(body).toMatch(/no (escribas|edites) código/i);
  });

  it("implement-task sigue TDD, marca el checklist y entrega commits sobre un worktree limpio", () => {
    const { body } = parseSkill("implement-task");
    for (const piece of [
      "update_checklist",
      "test que falla",
      "implementación mínima",
      "refactor",
      "criterionTests",
      "verificationHistory",
      "mustFix",
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

  it("verify-task lanza los 4 revisores por nombre, sin segundo plano, y no edita código", () => {
    const { body } = parseSkill("verify-task");
    for (const reviewer of REVIEWERS) expect(body, reviewer).toContain(reviewer);
    expect(body).toMatch(/segundo plano/);
    expect(body).toMatch(/no edites/i);
    for (const piece of [
      "justification",
      "prueba de reversión",
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
    ]) {
      expect(body, piece).toContain(piece);
    }
  });

  it("verify-task trae además el cuerpo de un pass", () => {
    const blocks = [...parseSkill("verify-task").body.matchAll(/```json\n([\s\S]*?)\n```/g)];
    const pass = JSON.parse(blocks[1]?.[1] ?? "{}");
    expect(pass.verdict).toBe("pass");
    expect(pass.mustFix).toEqual([]);
    expect(Object.keys(pass.reviewers).sort()).toEqual([...REVIEWERS].sort());
  });

  it("verify-task lleva el checklist de coherencia de tests del diseño", () => {
    const { body } = parseSkill("verify-task");
    for (const piece of [
      "al menos un test",
      "comportamiento observable",
      "tests saltados",
      "aserciones triviales",
      "invariantes",
      "se debilitó",
    ]) {
      expect(body, piece).toContain(piece);
    }
  });
});
