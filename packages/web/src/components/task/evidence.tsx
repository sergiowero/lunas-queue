// Archivo de evidencia `lunasq/tasks/{id}.md` del worktree (lo escribe UW-24), en markdown.
import { useQuery } from "@tanstack/react-query";
import Markdown from "react-markdown";
import { queries } from "../../lib/queries.ts";
import { Muted, Section } from "../section.tsx";
import { Loading, QueryError } from "../status.tsx";

const prose =
  "flex flex-col gap-2 text-sm [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_code]:text-xs [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5";

/** Sin worktree (aún no se crea o ya se limpió tras el PR) no hay de dónde leer el archivo. */
export function EvidencePanel({ taskId, hasWorktree }: { taskId: string; hasWorktree: boolean }) {
  const evidence = useQuery(queries.evidence(taskId));
  return (
    <Section title="Evidencia">
      {evidence.error ? (
        <QueryError error={evidence.error} />
      ) : evidence.isPending ? (
        <Loading />
      ) : evidence.data === null ? (
        <Muted>
          {hasWorktree
            ? "Todavía no hay archivo de evidencia."
            : "La tarea no tiene worktree: la evidencia viaja en su PR."}
        </Muted>
      ) : evidence.data ? (
        <div className="flex flex-col gap-3">
          <code className="text-xs text-muted-foreground">{evidence.data.path}</code>
          <div className={prose}>
            <Markdown>{evidence.data.markdown}</Markdown>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
