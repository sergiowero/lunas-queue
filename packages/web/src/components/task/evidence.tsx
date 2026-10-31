// Archivo de evidencia `lunasq/tasks/{id}.md` (lo escribe UW-24), en markdown: del worktree o,
// si ya se limpió, de la branch de la tarea o de la rama base tras el merge. Nace colapsado,
// con el mismo estilo que el Event log.
import type { EvidenceSource } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import Markdown from "react-markdown";
import { queries } from "../../lib/queries.ts";
import { Muted, Section } from "../section.tsx";
import { Loading, QueryError } from "../status.tsx";

const prose =
  "flex flex-col gap-2 text-sm [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_code]:text-xs [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5";

const SOURCE_LABEL: Record<EvidenceSource, string> = {
  worktree: "worktree",
  branch: "branch de la tarea",
  base: "rama base (mergeada)",
};

const useEvidence = (taskId: string) => useQuery(queries.evidence(taskId));

export function EvidencePanel({ taskId }: { taskId: string }) {
  const evidence = useEvidence(taskId);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return (
    <Section title="Evidencia">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? contentId : undefined}
        onClick={() => setExpanded((open) => !open)}
        className="cursor-pointer text-left text-sm text-muted-foreground hover:underline"
      >
        {expanded ? "Ocultar evidencia" : "Mostrar evidencia"}
      </button>
      {expanded ? (
        <div id={contentId} className="mt-3">
          <EvidenceBody evidence={evidence} />
        </div>
      ) : null}
    </Section>
  );
}

function EvidenceBody({ evidence }: { evidence: ReturnType<typeof useEvidence> }) {
  return (
    <>
      {evidence.error ? (
        <QueryError error={evidence.error} />
      ) : evidence.isPending ? (
        <Loading />
      ) : evidence.data === null ? (
        <Muted>Todavía no hay archivo de evidencia.</Muted>
      ) : evidence.data ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {`Desde ${SOURCE_LABEL[evidence.data.source]}: `}
            <code>{evidence.data.path}</code>
          </p>
          <div className={prose}>
            <Markdown>{evidence.data.markdown}</Markdown>
          </div>
        </div>
      ) : null}
    </>
  );
}
