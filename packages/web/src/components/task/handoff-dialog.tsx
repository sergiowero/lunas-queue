import type { ReactNode } from "react";
import { Button } from "../ui/button.tsx";
import { Dialog } from "../ui/dialog.tsx";

const LABELS: Record<string, string> = {
  schemaVersion: "Versión del esquema",
  taskId: "ID de tarea",
  runId: "ID del Run",
  phase: "Fase",
  result: "Resultado",
  summary: "Resumen",
  relevantFiles: "Archivos relevantes",
  decisions: "Decisiones",
  decision: "Decisión",
  rationale: "Fundamento",
  discarded: "Alternativas descartadas",
  knownRisks: "Riesgos conocidos",
  body: "Contenido",
  title: "Título",
  domainModel: "Modelo de dominio",
  boundedContext: "Contexto delimitado",
  glossary: "Glosario",
  term: "Término",
  definition: "Definición",
  aggregates: "Agregados",
  entities: "Entidades",
  invariants: "Invariantes",
  events: "Eventos",
  name: "Nombre",
  description: "Descripción",
  requirements: "Requisitos",
  criteria: "Criterios de aceptación",
  id: "Identificador",
  given: "Dado",
  when: "Cuando",
  outcome: "Entonces",
  taskList: "Lista de tareas",
  criterionIds: "Criterios relacionados",
  assumptions: "Supuestos",
  criterionTests: "Tests por criterio",
  tests: "Pruebas",
  file: "Archivo",
  criterionId: "Criterio",
  commits: "Commits",
  changesByModule: "Cambios por módulo",
  module: "Módulo",
  howToTest: "Cómo probar",
  commands: "Comandos",
  specDeviations: "Desviaciones de la spec",
  deviation: "Desviación",
  reason: "Motivo",
  verdict: "Veredicto",
  criteriaVerdicts: "Veredictos de criterios",
  reviewers: "Revisores",
  mustFix: "Hallazgos pendientes",
  refuted: "Hallazgos refutados",
  riskLabel: "Nivel de riesgo",
  status: "Estado",
  findings: "Hallazgos",
  severity: "Severidad",
  line: "Línea",
  evidence: "Evidencia",
  source: "Origen",
  justification: "Justificación",
  skipped: "Omitido",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function labelFor(key: string): string {
  return (
    LABELS[key] ??
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/^./, (character) => character.toLocaleUpperCase("es"))
  );
}

function formatValue(key: string, value: string): string {
  if (key === "phase") {
    return (
      {
        refinement: "Refinamiento",
        implementation: "Implementación",
        verification: "Verificación",
      }[value] ?? value
    );
  }
  if (key === "result") {
    return { completed: "Completado", partial: "Parcial" }[value] ?? value;
  }
  if (key === "verdict") {
    return { pass: "Aprobado", reject: "Rechazado", fail: "Fallido" }[value] ?? value;
  }
  if (key === "status") {
    return { ran: "Ejecutado", skipped: "Omitido" }[value] ?? value;
  }
  if (key === "severity") {
    return { critical: "Crítica", major: "Alta", minor: "Baja" }[value] ?? value;
  }
  return value;
}

function ValueView({
  label,
  value,
  valueKey = label,
}: {
  label: string;
  value: unknown;
  valueKey?: string;
}) {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    const occurrences = new Map<string, number>();
    return (
      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">
          {label} ({value.length})
        </summary>
        {value.length === 0 ? (
          <p className="pt-2 text-sm text-muted-foreground">Sin elementos.</p>
        ) : (
          <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5">
            {value.map((item) => {
              const identity = JSON.stringify(item) ?? String(item);
              const occurrence = occurrences.get(identity) ?? 0;
              occurrences.set(identity, occurrence + 1);
              return (
                <li key={`${label}-${identity}-${occurrence}`} className="pl-1">
                  {isRecord(item) ? (
                    <RecordView value={item} />
                  ) : (
                    <ValueView label={label} value={item} />
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </details>
    );
  }

  if (isRecord(value)) {
    return (
      <section className="rounded-md border border-border p-3">
        <h4 className="mb-2 text-sm font-medium">{label}</h4>
        <RecordView value={value} />
      </section>
    );
  }

  const text = typeof value === "string" ? formatValue(valueKey, value) : String(value);
  return (
    <div className="grid gap-1 sm:grid-cols-[minmax(8rem,0.35fr)_1fr] sm:gap-3">
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-sm">{text}</dd>
    </div>
  );
}

function RecordView({ value }: { value: Record<string, unknown> }) {
  return (
    <dl className="flex flex-col gap-3">
      {Object.entries(value).map(([key, child]) => (
        <ValueView key={key} label={labelFor(key)} value={child} valueKey={key} />
      ))}
    </dl>
  );
}

function HandoffValue({ handoff, onClose }: { handoff: unknown; onClose: () => void }) {
  const phase =
    isRecord(handoff) && typeof handoff.phase === "string"
      ? formatValue("phase", handoff.phase)
      : null;
  const title = phase ? `Handoff · ${phase}` : "Handoff";
  const envelope = isRecord(handoff) ? handoff : {};
  const { summary, phase: _phase, result, body, ...metadata } = envelope;
  const hasMetadata = Object.keys(metadata).length > 0;

  return (
    <Dialog title={title} onClose={onClose}>
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
        <div className="flex flex-wrap gap-2">
          {typeof result === "string" && (
            <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium">
              {formatValue("result", result)}
            </span>
          )}
        </div>
        {typeof summary === "string" && (
          <section className="rounded-md bg-muted p-4">
            <h3 className="mb-1 text-sm font-semibold">Resumen</h3>
            <p className="whitespace-pre-wrap text-sm">{summary}</p>
          </section>
        )}
        {body !== undefined && <ValueView label="Contenido" value={body} />}
        {hasMetadata && (
          <details className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Metadatos del handoff</summary>
            <div className="mt-3">
              <RecordView value={metadata} />
            </div>
          </details>
        )}
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function HandoffDialog({
  handoff,
  onClose,
}: {
  handoff: unknown;
  onClose: () => void;
}): ReactNode {
  return <HandoffValue handoff={handoff} onClose={onClose} />;
}
