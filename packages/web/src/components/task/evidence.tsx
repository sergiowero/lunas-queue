// Evidence file `lunasq/tasks/{id}.md` (written by the evidence service), in markdown: from the worktree or,
// if it was already cleaned up, from the task's branch or the base branch after the merge. It starts collapsed,
// with the same style as the Event log.
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useT } from "../../lib/i18n.ts";
import { queries } from "../../lib/queries.ts";
import { MarkdownText } from "../markdown-text.tsx";
import { Muted, Section } from "../section.tsx";
import { Loading, QueryError } from "../status.tsx";

const useEvidence = (taskId: string) => useQuery(queries.evidence(taskId));

export function EvidencePanel({ taskId }: { taskId: string }) {
  const t = useT();
  const evidence = useEvidence(taskId);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return (
    <Section title={t.evidence.title}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? contentId : undefined}
        onClick={() => setExpanded((open) => !open)}
        className="cursor-pointer text-left text-sm text-muted-foreground hover:underline"
      >
        {expanded ? t.evidence.hide : t.evidence.show}
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
  const t = useT();
  return (
    <>
      {evidence.error ? (
        <QueryError error={evidence.error} />
      ) : evidence.isPending ? (
        <Loading />
      ) : evidence.data === null ? (
        <Muted>{t.evidence.empty}</Muted>
      ) : evidence.data ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {t.evidence.from(t.evidence.source[evidence.data.source])}
            <code>{evidence.data.path}</code>
          </p>
          <MarkdownText>{evidence.data.markdown}</MarkdownText>
        </div>
      ) : null}
    </>
  );
}
