// Archivo de evidencia `lunasq/tasks/{id}.md` del worktree (lo escribe UW-24), en markdown.
import { useQuery } from "@tanstack/react-query";
import Markdown from "react-markdown";
import { queries } from "../../lib/queries.ts";
import { Muted, Section } from "../section.tsx";
import { QueryError } from "../status.tsx";

const prose =
  "flex flex-col gap-2 text-sm [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_code]:text-xs [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5";

export function EvidencePanel({ taskId }: { taskId: string }) {
  const evidence = useQuery(queries.evidence(taskId));
  return (
    <Section title="Evidencia">
      {evidence.error ? (
        <QueryError error={evidence.error} />
      ) : evidence.data === null ? (
        <Muted>Todavía no hay archivo de evidencia.</Muted>
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
