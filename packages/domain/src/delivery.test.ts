import { describe, expect, it } from "vitest";
import {
  commitTrailers,
  deliveryFacts,
  MAX_PR_BODY_CHARS,
  prBody,
  prTitle,
  riskPrLabel,
} from "./delivery.ts";

const criteria = [
  { id: "AC-1", given: "un pedido pendiente", when: "se cancela", outcome: "queda cancelado" },
  { id: "AC-2", given: "un pedido enviado", when: "se cancela", outcome: "se rechaza" },
];

const verification = (
  verdicts: ("pass" | "fail")[],
  verdict: "pass" | "reject" = "pass",
  reviewers: Record<string, { status: "ran" | "skipped"; justification?: string }> = {},
) => ({
  verdict,
  criteriaVerdicts: verdicts.map((v, i) => ({
    criterionId: `AC-${i + 1}`,
    verdict: v,
    evidence: `prueba del criterio ${i + 1}`,
  })),
  reviewers,
  refuted: [{ reason: "falso positivo" }],
  riskLabel: "medium" as const,
});

describe("deliveryFacts", () => {
  const implementation = {
    criterionTests: [
      { criterionId: "AC-1", tests: [{}] },
      { criterionId: "AC-2", tests: [{}] },
    ],
  };

  it("un pass con todos los criterios en pass y con test es completo", () => {
    expect(
      deliveryFacts({ criteria, implementation, verification: verification(["pass", "pass"]) }),
    ).toEqual({
      verifierPassed: true,
      testsCoherent: true,
      allCriteriaPassed: true,
    });
  });

  it("un criterio sin veredicto o en fail no cuenta como pasado", () => {
    expect(
      deliveryFacts({ criteria, implementation, verification: verification(["pass"]) })
        .allCriteriaPassed,
    ).toBe(false);
    expect(
      deliveryFacts({ criteria, implementation, verification: verification(["pass", "fail"]) })
        .allCriteriaPassed,
    ).toBe(false);
  });

  it("un criterio sin tests, o sin handoff de implementación, no es coherente", () => {
    const partial = { criterionTests: [{ criterionId: "AC-1", tests: [{}] }] };
    const v = verification(["pass", "pass"]);
    expect(
      deliveryFacts({ criteria, implementation: partial, verification: v }).testsCoherent,
    ).toBe(false);
    expect(
      deliveryFacts({
        criteria,
        implementation: {
          criterionTests: [
            { criterionId: "AC-1", tests: [{}] },
            { criterionId: "AC-2", tests: [] },
          ],
        },
        verification: v,
      }).testsCoherent,
    ).toBe(false);
    expect(deliveryFacts({ criteria, implementation: null, verification: v }).testsCoherent).toBe(
      false,
    );
  });

  it("un reject no es un pass del verificador", () => {
    expect(
      deliveryFacts({
        criteria,
        implementation,
        verification: verification(["pass", "pass"], "reject"),
      }).verifierPassed,
    ).toBe(false);
  });
});

describe("commitTrailers", () => {
  const runs = [
    { id: "impl-1", phase: "implement" as const, startedAt: new Date("2026-01-01T10:00:00Z") },
    { id: "verify-1", phase: "verify" as const, startedAt: new Date("2026-01-01T11:00:00Z") },
    { id: "impl-2", phase: "implement" as const, startedAt: new Date("2026-01-01T12:00:00Z") },
  ];

  it("cada commit lleva la tarea y el Run de implementación que estaba vivo al crearlo", () => {
    const commits = [
      { sha: "a", authoredAt: new Date("2026-01-01T10:30:00Z") },
      { sha: "b", authoredAt: new Date("2026-01-01T12:30:00Z") },
    ];
    expect(commitTrailers({ taskId: "t1", commits, runs, fallbackRunId: "verify-9" })).toEqual({
      a: { "LunasQ-Task": "t1", "LunasQ-Run": "impl-1" },
      b: { "LunasQ-Task": "t1", "LunasQ-Run": "impl-2" },
    });
  });

  it("un commit anterior a todo Run de implementación usa el primero; sin Runs, el de respaldo", () => {
    const early = [{ sha: "a", authoredAt: new Date("2025-12-31T00:00:00Z") }];
    expect(commitTrailers({ taskId: "t1", commits: early, runs, fallbackRunId: "v" }).a).toEqual({
      "LunasQ-Task": "t1",
      "LunasQ-Run": "impl-1",
    });
    expect(
      commitTrailers({ taskId: "t1", commits: early, runs: [], fallbackRunId: "v" }).a,
    ).toEqual({
      "LunasQ-Task": "t1",
      "LunasQ-Run": "v",
    });
  });
});

describe("prTitle", () => {
  it("usa la primera línea del intent, sin espacios de más", () => {
    expect(prTitle("  Permitir   cancelar pedidos\n\ncon motivo")).toBe(
      "Permitir cancelar pedidos",
    );
  });

  it("recorta a 72 caracteres", () => {
    const title = prTitle("x".repeat(200));
    expect(title).toHaveLength(72);
    expect(title.endsWith("…")).toBe(true);
  });

  it("prefiere el título de la tarea al intent", () => {
    expect(prTitle("Permitir cancelar pedidos\n\ncon motivo", "  Cancelar   pedidos ")).toBe(
      "Cancelar pedidos",
    );
  });

  it("sin título (null o vacío) cae al intent", () => {
    expect(prTitle("Permitir cancelar pedidos", null)).toBe("Permitir cancelar pedidos");
    expect(prTitle("Permitir cancelar pedidos", " ")).toBe("Permitir cancelar pedidos");
  });

  it("un intent vacío da un título genérico", () => {
    expect(prTitle("  \n ")).toBe("Tarea de LunasQ");
  });
});

describe("riskPrLabel", () => {
  it("una etiqueta por nivel de riesgo, con color distinto", () => {
    const labels = (["low", "medium", "high"] as const).map(riskPrLabel);
    expect(labels.map((l) => l.name)).toEqual([
      "lunasq:risk-low",
      "lunasq:risk-medium",
      "lunasq:risk-high",
    ]);
    expect(new Set(labels.map((l) => l.color)).size).toBe(3);
  });
});

describe("prBody", () => {
  const input = {
    taskId: "t1",
    runId: "verify-1",
    intent: "Permitir cancelar pedidos",
    specVersion: 2,
    criteria,
    verification: verification(["pass", "pass"], "pass", {
      "lunasq-security-reviewer": { status: "ran" },
      "lunasq-ux-reviewer": { status: "skipped", justification: "no hay UI" },
    }),
    evidencePath: "lunasq/tasks/t1.md",
    baseBranch: "main",
  };

  it("incluye intent, criterios con su evidencia, riesgo y trailers", () => {
    const body = prBody(input);
    expect(body).toContain("## Intent\n\nPermitir cancelar pedidos");
    expect(body).toContain("**AC-1**");
    expect(body).toContain("un pedido pendiente");
    expect(body).toContain("prueba del criterio 1");
    expect(body).toContain("Riesgo: **medio**");
    expect(body).toContain("LunasQ-Task: t1");
    expect(body).toContain("LunasQ-Run: verify-1");
    expect(body).toContain("`lunasq/tasks/t1.md`");
  });

  it("lista los revisores que corrieron y los omitidos con su justificación", () => {
    const body = prBody(input);
    expect(body).toContain("lunasq-security-reviewer");
    expect(body).toContain("lunasq-ux-reviewer");
    expect(body).toContain("no hay UI");
    expect(body).toContain("1 hallazgo refutado");
  });

  it("un cuerpo enorme se recorta con un aviso", () => {
    const body = prBody({
      ...input,
      verification: {
        ...input.verification,
        criteriaVerdicts: input.verification.criteriaVerdicts.map((c) => ({
          ...c,
          evidence: "e".repeat(MAX_PR_BODY_CHARS),
        })),
      },
    });
    expect(body.length).toBeLessThanOrEqual(MAX_PR_BODY_CHARS);
    expect(body).toContain("LunasQ-Task: t1");
  });
});
