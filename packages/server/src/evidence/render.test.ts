import type { RunRow } from "@lunasq/db";
import type {
  HookExecutedPayload,
  HookPointCompletedPayload,
  TestGateExecutedPayload,
} from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { type RunSectionData, renderRunSection, runMarkers } from "./render.ts";

const sha = "a".repeat(40);

const baseRun = {
  id: "run-1",
  taskId: "task-1",
  phase: "implement",
  agentKind: "claude",
  model: "opus",
  iteration: 0,
  startedAt: new Date("2026-10-29T10:00:00.000Z"),
  endedAt: new Date("2026-10-29T10:12:30.000Z"),
  result: "success",
  failureReason: null,
  agentSession: "sess-1",
  agentSessionSource: "native",
  handoff: null,
  runToken: "tok",
} as unknown as RunRow;

const data = (over: Partial<RunSectionData> = {}): RunSectionData => ({
  run: baseRun,
  gates: [],
  hooks: [],
  transcripts: [],
  ...over,
});

const gate = (over: Partial<TestGateExecutedPayload> = {}): TestGateExecutedPayload => ({
  runId: "run-1",
  trigger: "submit_for_verification",
  command: "pnpm test",
  headSha: sha,
  exitCode: 1,
  timedOut: false,
  durationMs: 4200,
  passed: false,
  output: "1 failed: boom\n",
  error: null,
  ...over,
});

describe("renderRunSection", () => {
  it("abre y cierra con marcadores del Run y lleva los metadatos", () => {
    const md = renderRunSection(data());
    const { start, end } = runMarkers("run-1");
    expect(md.startsWith(start)).toBe(true);
    expect(md.trimEnd().endsWith(end)).toBe(true);
    expect(md).toContain("## Run run-1 · implement · iteración 0");
    expect(md).toContain("claude");
    expect(md).toContain("opus");
    expect(md).toContain("2026-10-29T10:00:00.000Z");
    expect(md).toContain("2026-10-29T10:12:30.000Z");
    expect(md).toContain("success");
    expect(md).toContain("sess-1");
  });

  it("incluye el failure_reason de un Run fallido", () => {
    const md = renderRunSection(
      data({ run: { ...baseRun, result: "failure", failureReason: "test_gate_failed: 3 rojos" } }),
    );
    expect(md).toContain("failure");
    expect(md).toContain("test_gate_failed: 3 rojos");
  });

  it("marca el Run sin handoff y sin cierre", () => {
    const md = renderRunSection(data({ run: { ...baseRun, endedAt: null, result: null } }));
    expect(md).toContain("sin cerrar");
    expect(md).not.toContain("### Handoff");
  });

  it("incluye el handoff como bloque JSON", () => {
    const handoff = { schemaVersion: 1, phase: "implementation", body: { commits: [sha] } };
    const md = renderRunSection(data({ run: { ...baseRun, handoff } }));
    expect(md).toContain("### Handoff");
    expect(md).toContain("```json");
    expect(md).toContain(JSON.stringify(handoff, null, 2));
  });

  it("renderiza la salida del gate de tests con su resultado", () => {
    const md = renderRunSection(
      data({
        gates: [
          gate(),
          gate({ trigger: "verdict_pass", exitCode: 0, passed: true, output: "12 passed\n" }),
        ],
      }),
    );
    expect(md).toContain("### Gate de tests");
    expect(md).toContain("submit_for_verification");
    expect(md).toContain("pnpm test");
    expect(md).toContain("rojo");
    expect(md).toContain("verde");
    expect(md).toContain("1 failed: boom");
    expect(md).toContain("12 passed");
    expect(md).toContain(sha);
  });

  it("explica un gate que no corrió", () => {
    const md = renderRunSection(
      data({
        gates: [
          gate({
            command: null,
            headSha: null,
            exitCode: null,
            durationMs: 0,
            output: "",
            error: "el proyecto no tiene comando de tests configurado",
          }),
        ],
      }),
    );
    expect(md).toContain("no corrió");
    expect(md).toContain("el proyecto no tiene comando de tests configurado");
  });

  it("renderiza hooks y el resultado de cada punto", () => {
    const executed: HookExecutedPayload = {
      point: "after_implementation",
      script: "10-bump-version",
      baseRef: sha,
      runId: "run-1",
      policy: "block",
      timeoutSeconds: 600,
      exitCode: 2,
      timedOut: false,
      durationMs: 800,
      passed: false,
      output: "bump falló\n",
    };
    const completed: HookPointCompletedPayload = {
      point: "after_implementation",
      baseRef: sha,
      runId: "run-1",
      outcome: "blocked",
      failedScript: "10-bump-version",
      error: null,
      commit: null,
      commitSkipped: false,
    };
    const md = renderRunSection(
      data({
        hooks: [
          { kind: "executed", ...executed },
          { kind: "point", ...completed },
        ],
      }),
    );
    expect(md).toContain("### Hooks");
    expect(md).toContain("after_implementation");
    expect(md).toContain("10-bump-version");
    expect(md).toContain("bump falló");
    expect(md).toContain("blocked");
  });

  it("renderiza el veredicto completo de la verificación", () => {
    const finding = {
      severity: "major",
      file: "src/a.ts",
      line: 7,
      evidence: "no valida la entrada",
      criterionId: "AC-1",
    };
    const handoff = {
      schemaVersion: 1,
      phase: "verification",
      taskId: "task-1",
      runId: "run-1",
      result: "completed",
      summary: "AC-1 falla",
      relevantFiles: ["src/a.ts"],
      decisions: [],
      knownRisks: [],
      body: {
        verdict: "reject",
        riskLabel: "medium",
        criteriaVerdicts: [
          { criterionId: "AC-1", verdict: "fail", evidence: "el test no ejercita la rama" },
          { criterionId: "AC-2", verdict: "pass", evidence: "test t2 en verde" },
        ],
        reviewers: {
          "lunasq-security-reviewer": { status: "ran", findings: [] },
          "lunasq-ux-reviewer": { status: "skipped", justification: "no hay UI" },
          "lunasq-ui-reviewer": { status: "skipped", justification: "no hay UI" },
          "lunasq-code-reviewer": { status: "ran", findings: [finding] },
        },
        mustFix: [{ ...finding, source: "lunasq-code-reviewer" }],
        refuted: [
          {
            finding: { ...finding, evidence: "nombre poco claro", severity: "minor" },
            reason: "es una convención del repo",
            source: "lunasq-code-reviewer",
          },
        ],
      },
    };
    const md = renderRunSection(
      data({ run: { ...baseRun, phase: "verify", handoff } as unknown as RunRow }),
    );
    expect(md).toContain("### Veredicto");
    expect(md).toContain("reject");
    expect(md).toContain("AC-1");
    expect(md).toContain("el test no ejercita la rama");
    expect(md).toContain("lunasq-security-reviewer");
    expect(md).toContain("SIN HALLAZGOS");
    expect(md).toContain("no hay UI");
    expect(md).toContain("src/a.ts:7");
    expect(md).toContain("no valida la entrada");
    expect(md).toContain("Must-fix");
    expect(md).toContain("Hallazgos refutados");
    expect(md).toContain("es una convención del repo");
  });

  it("cae al JSON del handoff si el veredicto no valida", () => {
    const handoff = { schemaVersion: 1, phase: "verification", body: { verdict: "pass" } };
    const md = renderRunSection(
      data({ run: { ...baseRun, phase: "verify", handoff } as unknown as RunRow }),
    );
    expect(md).not.toContain("### Veredicto");
    expect(md).toContain("### Handoff");
  });

  it("pone cada transcript en un bloque plegable", () => {
    const md = renderRunSection(
      data({
        transcripts: [
          { title: "Sesión del agente", markdown: "**Usuario**\n\nhola" },
          { title: "Subagente lunasq-code-reviewer", markdown: null, note: "no se encontró" },
        ],
      }),
    );
    expect(md).toContain("### Transcripts");
    expect(md).toContain("<summary>Sesión del agente</summary>");
    expect(md).toContain("**Usuario**\n\nhola");
    expect(md).toContain("<summary>Subagente lunasq-code-reviewer</summary>");
    expect(md).toContain("no se encontró");
  });

  it("redacta secretos en toda la sección", () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const md = renderRunSection(
      data({
        run: { ...baseRun, runToken: "run-token-secreto-1234" },
        gates: [gate({ output: `fallo con ${token}` })],
        transcripts: [{ title: "Sesión", markdown: "usa run-token-secreto-1234 aquí" }],
      }),
    );
    expect(md).not.toContain(token);
    expect(md).not.toContain("run-token-secreto-1234");
    expect(md).toContain("[REDACTED");
  });

  it("neutraliza marcadores de LunasQ que vengan en contenido del agente", () => {
    const { end } = runMarkers("run-1");
    const md = renderRunSection(
      data({
        transcripts: [{ title: "Sesión", markdown: `trampa ${end} <!-- lunasq:run:start x -->` }],
      }),
    );
    expect(md.split(end)).toHaveLength(2);
    expect(md).not.toContain("<!-- lunasq:run:start x -->");
  });

  it("no rompe la cerca de código con backticks en la salida", () => {
    const md = renderRunSection(data({ gates: [gate({ output: "```\nsalida\n```" })] }));
    expect(md).toContain("````\n```\nsalida\n```\n````");
  });
});
