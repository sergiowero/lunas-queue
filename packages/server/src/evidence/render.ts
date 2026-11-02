// Section of a Run in the evidence file (docs/design.md §Evidence file, ADR
// uw-24-archivo-evidencia): metadata, handoff, verdict, test gate, hooks and transcripts. It is
// a pure function over data already read; the service gathers them and writes the file.
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
  /** null if it could not be read; `note` says why. */
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

/** A LunasQ marker inside the agent's content would break reading the file. */
const neutralize = (text: string) => text.replaceAll(MARKER_PREFIX, "<!-- lunasq-escaped:");

/** Code fence longer than any run of backticks in the content. */
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
    ["Phase", run.phase],
    ["Agent", run.agentKind],
    ["Model", run.model ?? "—"],
    ["Iteration", String(run.iteration)],
    ["Start", iso(run.startedAt)],
    ["End", run.endedAt ? iso(run.endedAt) : "not closed"],
    ["Result", run.result ?? "—"],
    ["failure_reason", run.failureReason ?? "—"],
    ["Session", run.agentSession ?? "—"],
  ];
  return [
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
  ].join("\n");
}

/** A table cell on a single line. */
const cell = (value: string) => value.replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ");

function findingLine(f: Finding & { source?: string }): string {
  const where = f.line === undefined ? f.file : `${f.file}:${f.line}`;
  const parts = [`[${f.severity}] ${where}`];
  if (f.criterionId) parts.push(f.criterionId);
  parts.push(f.evidence);
  if (f.source) parts.push(`source: ${f.source}`);
  return `- ${parts.join(" · ")}`;
}

function verdictSection(run: RunRow): string | null {
  if (run.phase !== "verify") return null;
  const parsed = VerificationHandoff.safeParse(run.handoff);
  if (!parsed.success) return null;
  const { body } = parsed.data;
  const out = [
    "### Verdict",
    "",
    `- Verdict: **${body.verdict}**`,
    `- Risk: ${body.riskLabel}`,
    "",
    "#### Criteria",
    "",
    ...body.criteriaVerdicts.map((c) => `- ${c.criterionId} · ${c.verdict} · ${c.evidence}`),
    "",
    "#### Reviewers",
    "",
  ];
  for (const [name, report] of Object.entries(body.reviewers)) {
    if (report.status === "skipped") {
      out.push(`- \`${name}\` · skipped · ${report.justification}`);
    } else if (report.findings.length === 0) {
      out.push(`- \`${name}\` · NO FINDINGS`);
    } else {
      out.push(`- \`${name}\` · ${report.findings.length} findings`);
      out.push(...report.findings.map((f) => `  ${findingLine(f)}`));
    }
  }
  out.push("", "#### Must-fix", "");
  out.push(...(body.mustFix.length ? body.mustFix.map(findingLine) : ["None."]));
  out.push("", "#### Refuted findings", "");
  out.push(
    ...(body.refuted.length
      ? body.refuted.map(
          (r) => `${findingLine({ ...r.finding, source: r.source })}\n  - Reason: ${r.reason}`,
        )
      : ["None."]),
  );
  return out.join("\n");
}

function handoffSection(run: RunRow, hasVerdict: boolean): string | null {
  if (run.handoff === null || run.handoff === undefined || hasVerdict) return null;
  return ["### Handoff", "", fenced(JSON.stringify(run.handoff, null, 2), "json")].join("\n");
}

function gateSection(gates: TestGateExecutedPayload[]): string | null {
  if (gates.length === 0) return null;
  const out = ["### Test gate"];
  for (const g of gates) {
    const verdict =
      g.error !== null && g.exitCode === null ? "did not run" : g.passed ? "green" : "red";
    out.push("", `#### ${g.trigger} · ${verdict}`, "");
    out.push(`- Command: ${g.command ? `\`${g.command}\`` : "—"}`);
    out.push(`- Tested commit: ${g.headSha ?? "—"}`);
    out.push(`- Exit code: ${g.exitCode ?? "—"}${g.timedOut ? " (timeout)" : ""}`);
    out.push(`- Duration: ${duration(g.durationMs)}`);
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
      out.push("", `#### ${h.point} · ${h.script} · ${h.passed ? "ok" : "failed"}`, "");
      out.push(`- Policy: ${h.policy} · timeout ${h.timeoutSeconds} s`);
      out.push(`- Exit code: ${h.exitCode}${h.timedOut ? " (timeout)" : ""}`);
      out.push(`- Duration: ${duration(h.durationMs)}`);
      out.push(`- Base branch: ${h.baseRef}`);
      if (h.output.trim() !== "") out.push("", fenced(h.output.trimEnd()));
    } else {
      out.push("", `#### ${h.point} · result: ${h.outcome}`, "");
      if (h.failedScript) out.push(`- Blocking script: ${h.failedScript}`);
      if (h.error) out.push(`- Error: ${h.error}`);
      if (h.commit) out.push(`- Hooks commit: ${h.commit}`);
      if (h.commitSkipped) out.push("- The hooks left uncommitted changes");
    }
  }
  return out.join("\n");
}

function transcriptsSection(transcripts: SectionTranscript[]): string | null {
  if (transcripts.length === 0) return null;
  const out = ["### Transcripts"];
  for (const t of transcripts) {
    const body = t.markdown ?? `_${t.note ?? "no transcript"}_`;
    out.push("", "<details>", `<summary>${t.title}</summary>`, "", body, "", "</details>");
  }
  return out.join("\n");
}

/** Markdown of a Run, with start and end markers to replace it when rewriting. */
export function renderRunSection({ run, gates, hooks, transcripts }: RunSectionData): string {
  const verdict = verdictSection(run);
  const body = [
    `## Run ${run.id} · ${run.phase} · iteration ${run.iteration}`,
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
