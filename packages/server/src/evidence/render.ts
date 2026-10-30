// Sección de un Run del archivo de evidencia (docs/design.md §Archivo de evidencia, ADR
// uw-24-archivo-evidencia): metadatos, handoff, veredicto, gate de tests, hooks y transcripts. Es
// una función pura sobre datos ya leídos; el servicio los reúne y escribe el archivo.
import type { RunRow } from "@lunasq/db";
import {
  type Finding,
  type HookExecutedPayload,
  type HookPointCompletedPayload,
  type TestGateExecutedPayload,
  VerificationHandoff,
} from "@lunasq/schemas";
import { redactSecrets } from "./redact.ts";

export type HookLogEntry =
  | ({ kind: "executed" } & HookExecutedPayload)
  | ({ kind: "point" } & HookPointCompletedPayload);

export type SectionTranscript = {
  title: string;
  /** null si no se pudo leer; `note` dice por qué. */
  markdown: string | null;
  note?: string;
};

export type RunSectionData = {
  run: RunRow;
  gates: TestGateExecutedPayload[];
  hooks: HookLogEntry[];
  transcripts: SectionTranscript[];
};

const MARKER_PREFIX = "<!-- lunasq:";

export function runMarkers(runId: string) {
  return {
    start: `${MARKER_PREFIX}run:start ${runId} -->`,
    end: `${MARKER_PREFIX}run:end ${runId} -->`,
  };
}

/** Un marcador de LunasQ dentro del contenido del agente rompería la lectura del archivo. */
const neutralize = (text: string) => text.replaceAll(MARKER_PREFIX, "<!-- lunasq-escapado:");

/** Cerca de código más larga que cualquier racha de backticks del contenido. */
function fenced(text: string, lang = ""): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

const iso = (date: Date | null) => (date ? date.toISOString() : "—");

function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function metadata(run: RunRow): string {
  const rows: [string, string][] = [
    ["Fase", run.phase],
    ["Agente", run.agentKind],
    ["Modelo", run.model ?? "—"],
    ["Iteración", String(run.iteration)],
    ["Inicio", iso(run.startedAt)],
    ["Fin", run.endedAt ? iso(run.endedAt) : "sin cerrar"],
    ["Resultado", run.result ?? "—"],
    ["failure_reason", run.failureReason ?? "—"],
    ["Sesión", run.agentSession ?? "—"],
  ];
  return [
    "| Campo | Valor |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
  ].join("\n");
}

/** Una celda de tabla en una sola línea. */
const cell = (value: string) => value.replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ");

function findingLine(f: Finding & { source?: string }): string {
  const where = f.line === undefined ? f.file : `${f.file}:${f.line}`;
  const parts = [`[${f.severity}] ${where}`];
  if (f.criterionId) parts.push(f.criterionId);
  parts.push(f.evidence);
  if (f.source) parts.push(`origen: ${f.source}`);
  return `- ${parts.join(" · ")}`;
}

function verdictSection(run: RunRow): string | null {
  if (run.phase !== "verify") return null;
  const parsed = VerificationHandoff.safeParse(run.handoff);
  if (!parsed.success) return null;
  const { body } = parsed.data;
  const out = [
    "### Veredicto",
    "",
    `- Veredicto: **${body.verdict}**`,
    `- Riesgo: ${body.riskLabel}`,
    "",
    "#### Criterios",
    "",
    ...body.criteriaVerdicts.map((c) => `- ${c.criterionId} · ${c.verdict} · ${c.evidence}`),
    "",
    "#### Revisores",
    "",
  ];
  for (const [name, report] of Object.entries(body.reviewers)) {
    if (report.status === "skipped") {
      out.push(`- \`${name}\` · omitido · ${report.justification}`);
    } else if (report.findings.length === 0) {
      out.push(`- \`${name}\` · SIN HALLAZGOS`);
    } else {
      out.push(`- \`${name}\` · ${report.findings.length} hallazgos`);
      out.push(...report.findings.map((f) => `  ${findingLine(f)}`));
    }
  }
  out.push("", "#### Must-fix", "");
  out.push(...(body.mustFix.length ? body.mustFix.map(findingLine) : ["Ninguno."]));
  out.push("", "#### Hallazgos refutados", "");
  out.push(
    ...(body.refuted.length
      ? body.refuted.map(
          (r) => `${findingLine({ ...r.finding, source: r.source })}\n  - Motivo: ${r.reason}`,
        )
      : ["Ninguno."]),
  );
  return out.join("\n");
}

function handoffSection(run: RunRow, hasVerdict: boolean): string | null {
  if (run.handoff === null || run.handoff === undefined || hasVerdict) return null;
  return ["### Handoff", "", fenced(JSON.stringify(run.handoff, null, 2), "json")].join("\n");
}

function gateSection(gates: TestGateExecutedPayload[]): string | null {
  if (gates.length === 0) return null;
  const out = ["### Gate de tests"];
  for (const g of gates) {
    const verdict =
      g.error !== null && g.exitCode === null ? "no corrió" : g.passed ? "verde" : "rojo";
    out.push("", `#### ${g.trigger} · ${verdict}`, "");
    out.push(`- Comando: ${g.command ? `\`${g.command}\`` : "—"}`);
    out.push(`- Commit probado: ${g.headSha ?? "—"}`);
    out.push(`- Exit code: ${g.exitCode ?? "—"}${g.timedOut ? " (timeout)" : ""}`);
    out.push(`- Duración: ${duration(g.durationMs)}`);
    if (g.error) out.push(`- Error: ${g.error}`);
    if (g.output.trim() !== "") out.push("", fenced(g.output.trimEnd()));
  }
  return out.join("\n");
}

function hooksSection(hooks: HookLogEntry[]): string | null {
  if (hooks.length === 0) return null;
  const out = ["### Hooks"];
  for (const h of hooks) {
    if (h.kind === "executed") {
      out.push("", `#### ${h.point} · ${h.script} · ${h.passed ? "ok" : "falló"}`, "");
      out.push(`- Política: ${h.policy} · timeout ${h.timeoutSeconds} s`);
      out.push(`- Exit code: ${h.exitCode}${h.timedOut ? " (timeout)" : ""}`);
      out.push(`- Duración: ${duration(h.durationMs)}`);
      out.push(`- Rama base: ${h.baseRef}`);
      if (h.output.trim() !== "") out.push("", fenced(h.output.trimEnd()));
    } else {
      out.push("", `#### ${h.point} · resultado: ${h.outcome}`, "");
      if (h.failedScript) out.push(`- Script que bloqueó: ${h.failedScript}`);
      if (h.error) out.push(`- Error: ${h.error}`);
      if (h.commit) out.push(`- Commit de los hooks: ${h.commit}`);
      if (h.commitSkipped) out.push("- Los hooks dejaron cambios sin commitear");
    }
  }
  return out.join("\n");
}

function transcriptsSection(transcripts: SectionTranscript[]): string | null {
  if (transcripts.length === 0) return null;
  const out = ["### Transcripts"];
  for (const t of transcripts) {
    const body = t.markdown ?? `_${t.note ?? "sin transcript"}_`;
    out.push("", "<details>", `<summary>${t.title}</summary>`, "", body, "", "</details>");
  }
  return out.join("\n");
}

/** Markdown de un Run, con marcadores de inicio y fin para reemplazarlo al reescribir. */
export function renderRunSection({ run, gates, hooks, transcripts }: RunSectionData): string {
  const verdict = verdictSection(run);
  const body = [
    `## Run ${run.id} · ${run.phase} · iteración ${run.iteration}`,
    metadata(run),
    verdict,
    handoffSection(run, verdict !== null),
    gateSection(gates),
    hooksSection(hooks),
    transcriptsSection(transcripts),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
  const safe = redactSecrets(neutralize(body), { known: [run.runToken] });
  const { start, end } = runMarkers(run.id);
  return `${start}\n${safe}\n${end}\n`;
}
