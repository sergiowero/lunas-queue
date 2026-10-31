// Reglas puras de la entrega (docs/design.md §Entrega, ADR uw-26-entrega): los hechos que exige
// `verdict_pass`, los trailers de cada commit y el título, el cuerpo y la etiqueta del PR. Rebase,
// push y `gh` son del adapter; orquestarlos es de `DeliveryService` (server).
import {
  COMMIT_TRAILER_RUN,
  COMMIT_TRAILER_TASK,
  type Phase,
  type RiskLabel,
} from "@lunasq/schemas";

export interface DeliveryCriterion {
  id: string;
  given: string;
  when: string;
  outcome: string;
}

/** Lo del veredicto del verificador que usa la entrega. */
export interface DeliveryVerdict {
  verdict: "pass" | "reject";
  criteriaVerdicts: { criterionId: string; verdict: "pass" | "fail"; evidence: string }[];
  reviewers: Record<string, { status: "ran" | "skipped"; justification?: string }>;
  refuted: unknown[];
  riskLabel: RiskLabel;
}

export interface DeliveryFacts {
  verifierPassed: boolean;
  testsCoherent: boolean;
  allCriteriaPassed: boolean;
}

/**
 * Los hechos que la máquina de estados exige para `verdict_pass` además del gate y del PR: el
 * veredicto es pass, todo criterio de la spec tiene al menos un test en el handoff de
 * implementación y todo criterio pasó en el veredicto.
 */
export function deliveryFacts(input: {
  criteria: readonly { id: string }[];
  implementation: { criterionTests: { criterionId: string; tests: readonly unknown[] }[] } | null;
  verification: Pick<DeliveryVerdict, "verdict" | "criteriaVerdicts">;
}): DeliveryFacts {
  const tested = new Set(
    (input.implementation?.criterionTests ?? [])
      .filter((c) => c.tests.length > 0)
      .map((c) => c.criterionId),
  );
  const passed = new Set(
    input.verification.criteriaVerdicts
      .filter((c) => c.verdict === "pass")
      .map((c) => c.criterionId),
  );
  return {
    verifierPassed: input.verification.verdict === "pass",
    testsCoherent: input.criteria.every((c) => tested.has(c.id)),
    allCriteriaPassed: input.criteria.every((c) => passed.has(c.id)),
  };
}

/**
 * Trailers de cada commit de la tarea (por sha): la tarea y el Run de implementación que estaba
 * vivo cuando se escribió. Un commit anterior a todo Run usa el primero; sin Runs de
 * implementación, `fallbackRunId`. Un commit que ya trae los trailers (los de los hooks) conserva
 * los suyos: el adapter no repite una clave.
 */
export function commitTrailers(input: {
  taskId: string;
  commits: readonly { sha: string; authoredAt: Date }[];
  runs: readonly { id: string; phase: Phase; startedAt: Date }[];
  fallbackRunId: string;
}): Record<string, Record<string, string>> {
  const implementation = input.runs
    .filter((r) => r.phase === "implement")
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const result: Record<string, Record<string, string>> = {};
  for (const commit of input.commits) {
    const alive = implementation.filter((r) => r.startedAt <= commit.authoredAt).at(-1);
    result[commit.sha] = {
      [COMMIT_TRAILER_TASK]: input.taskId,
      [COMMIT_TRAILER_RUN]: (alive ?? implementation[0])?.id ?? input.fallbackRunId,
    };
  }
  return result;
}

const MAX_TITLE_CHARS = 72;

/**
 * Título del PR: el de la tarea y, mientras no tenga, la primera línea del intent, en una línea
 * y de hasta 72 caracteres.
 */
export function prTitle(intent: string, title?: string | null): string {
  const line = [title ?? "", ...intent.split("\n")]
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l !== "");
  if (!line) return "Tarea de LunasQ";
  return line.length <= MAX_TITLE_CHARS ? line : `${line.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

const RISK_LABELS: Record<RiskLabel, { name: string; color: string; description: string }> = {
  low: {
    name: "lunasq:risk-low",
    color: "0e8a16",
    description: "Riesgo bajo según el verificador",
  },
  medium: {
    name: "lunasq:risk-medium",
    color: "fbca04",
    description: "Riesgo medio según el verificador",
  },
  high: {
    name: "lunasq:risk-high",
    color: "b60205",
    description: "Riesgo alto según el verificador",
  },
};

/** Etiqueta de GitHub del riesgo que asignó el approver, para priorizar la revisión. */
export function riskPrLabel(risk: RiskLabel) {
  return RISK_LABELS[risk];
}

const RISK_TEXT: Record<RiskLabel, string> = { low: "bajo", medium: "medio", high: "alto" };

/** Límite de GitHub para el cuerpo de un PR es 65 536; queda margen. */
export const MAX_PR_BODY_CHARS = 60_000;

const MAX_EVIDENCE_CHARS = 1_500;

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/**
 * Descripción del PR: intent, criterios con su evidencia, etiqueta de riesgo, revisión y los
 * trailers de trazabilidad (docs/design.md §Entrega). Sale de los handoffs: la entrega no tiene
 * agente (ADR uw-18-skills-fase).
 */
export function prBody(input: {
  taskId: string;
  runId: string;
  intent: string;
  specVersion: number;
  criteria: readonly DeliveryCriterion[];
  verification: DeliveryVerdict;
  evidencePath: string;
  baseBranch: string;
}): string {
  const verdicts = new Map(input.verification.criteriaVerdicts.map((c) => [c.criterionId, c]));
  const criteria = input.criteria.map((c) => {
    const verdict = verdicts.get(c.id);
    const mark = verdict?.verdict === "pass" ? "✅" : "❌";
    return [
      `- ${mark} **${c.id}** — dado ${c.given}, cuando ${c.when}, entonces ${c.outcome}.`,
      verdict
        ? `  - Evidencia: ${clip(verdict.evidence, MAX_EVIDENCE_CHARS)}`
        : "  - Sin veredicto.",
    ].join("\n");
  });
  const reviewers = Object.entries(input.verification.reviewers).map(([name, report]) =>
    report.status === "ran"
      ? `- \`${name}\`: revisó`
      : `- \`${name}\`: omitido — ${report.justification ?? "sin justificación"}`,
  );
  const refuted = input.verification.refuted.length;
  const sections = [
    `## Intent\n\n${input.intent.trim()}`,
    `## Criterios de aceptación (spec v${input.specVersion})\n\n${criteria.join("\n")}`,
    `## Riesgo\n\nRiesgo: **${RISK_TEXT[input.verification.riskLabel]}** (etiqueta \`${RISK_LABELS[input.verification.riskLabel].name}\`), según el verificador.`,
    `## Verificación\n\n${reviewers.join("\n")}\n\n${refuted} hallazgo${refuted === 1 ? "" : "s"} refutado${refuted === 1 ? "" : "s"} por el approver. Rama integrada con \`${input.baseBranch}\` y suite de tests en verde antes del push.`,
    `## Trazabilidad\n\nEvidencia completa de cada Run: \`${input.evidencePath}\`.`,
  ];
  const trailers = `\n\n---\n\n${COMMIT_TRAILER_TASK}: ${input.taskId}\n${COMMIT_TRAILER_RUN}: ${input.runId}\n`;
  const body = sections.join("\n\n");
  const room = MAX_PR_BODY_CHARS - trailers.length;
  return body.length <= room
    ? `${body}${trailers}`
    : `${body.slice(0, room - 40)}\n\n… (recortado)${trailers}`;
}
