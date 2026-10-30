// Reglas del veredicto de verificación (docs/design.md §Verificación con subagentes, ADR
// uw-23-verificacion): lo que el approver reporta de cada revisor debe coincidir con lo que los
// hooks SubagentStart y SubagentStop registraron en el Run. Leer esos registros es de db.
import { type HandoffError, REVIEWER_NAMES, type VerificationBody } from "@lunasq/schemas";

/** Una ejecución de subagente registrada por los hooks del Run. */
export interface SubagentEvidence {
  agentType: string;
  startedAt: Date | null;
  stoppedAt: Date | null;
}

/**
 * Errores del veredicto frente a los hooks; vacío si cuadra. Un revisor `ran` debe tener al menos
 * una ejecución terminada; uno `skipped` no puede tenerla, porque el approver descartaría su
 * reporte. Un must-fix o un refutado no puede venir de un revisor omitido.
 */
export function checkReviewerEvidence(
  body: VerificationBody,
  subagents: readonly SubagentEvidence[],
): HandoffError[] {
  const issues: HandoffError[] = [];
  const runsOf = (name: string) => subagents.filter((s) => s.agentType === name);
  for (const name of REVIEWER_NAMES) {
    const report = body.reviewers[name];
    const runs = runsOf(name);
    const done = runs.some((s) => s.stoppedAt !== null);
    const path = `body.reviewers.${name}`;
    if (report.status === "ran" && !done) {
      issues.push({
        path,
        message:
          runs.length === 0
            ? `${name} se reporta ejecutado pero no aparece en los hooks del Run`
            : `${name} se reporta ejecutado pero no terminó (sin SubagentStop)`,
      });
    }
    if (report.status === "skipped" && done) {
      issues.push({
        path,
        message: `${name} corrió y terminó en este Run pero se reporta omitido: incluye su reporte`,
      });
    }
  }

  const skipped = (source: string) =>
    REVIEWER_NAMES.some((name) => name === source && body.reviewers[name].status === "skipped");
  body.mustFix.forEach((f, i) => {
    if (skipped(f.source)) {
      issues.push({ path: `body.mustFix[${i}].source`, message: omittedSource(f.source) });
    }
  });
  body.refuted.forEach((r, i) => {
    if (skipped(r.source)) {
      issues.push({ path: `body.refuted[${i}].source`, message: omittedSource(r.source) });
    }
  });
  return issues;
}

const omittedSource = (name: string) => `el hallazgo se atribuye a ${name}, que se reporta omitido`;
