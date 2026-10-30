// Event log de la tarea: quién la movió, cuándo y por qué (docs/design.md §Auditoría).
import type { EventView, TASK_TRANSITIONED, TaskTransitionedPayload } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import type { Json } from "../../lib/api.ts";
import { formatDate } from "../../lib/format.ts";
import { queries } from "../../lib/queries.ts";
import { Muted, Section } from "../section.tsx";
import { QueryError, stateText } from "../status.tsx";
import { Badge } from "../ui/badge.tsx";

// Solo tipos de @lunasq/schemas: importar sus valores mete zod en el bundle.
const TRANSITIONED: typeof TASK_TRANSITIONED = "task.transitioned";

function Detail({ event }: { event: Json<EventView> }) {
  if (event.type === TRANSITIONED) {
    const payload = event.payload as TaskTransitionedPayload;
    const extra = [payload.reason, payload.note].filter(Boolean).join(" · ");
    return (
      <>
        <span>{`${stateText(payload.from)} → ${stateText(payload.to)}`}</span>
        {extra && <span className="text-muted-foreground">{extra}</span>}
      </>
    );
  }
  if (event.payload === null || event.payload === undefined) return null;
  return (
    <code className="break-all text-xs text-muted-foreground">{JSON.stringify(event.payload)}</code>
  );
}

export function EventLogPanel({ taskId }: { taskId: string }) {
  const events = useQuery(queries.events(taskId));
  return (
    <Section title="Event log">
      {events.error ? (
        <QueryError error={events.error} />
      ) : events.data?.length === 0 ? (
        <Muted>Sin eventos.</Muted>
      ) : (
        <ol className="flex flex-col gap-2 text-sm">
          {(events.data ?? []).map((event) => (
            <li key={event.id} className="flex flex-wrap items-baseline gap-2">
              <time className="text-xs text-muted-foreground" dateTime={event.createdAt}>
                {formatDate(event.createdAt)}
              </time>
              <Badge variant="outline">{event.actor}</Badge>
              <span className="font-mono text-xs">{event.type}</span>
              <Detail event={event} />
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
