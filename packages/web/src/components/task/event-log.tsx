// Event log de la tarea: quién la movió, cuándo y por qué (docs/design.md §Auditoría).
import type {
  EventView,
  TASK_TRANSITIONED,
  TaskTransitionedPayload,
  TEST_GATE_EXECUTED,
  TestGateExecutedPayload,
} from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import type { Json } from "../../lib/api.ts";
import { formatDate, stripAnsi } from "../../lib/format.ts";
import { queries } from "../../lib/queries.ts";
import { Muted, Section } from "../section.tsx";
import { Loading, QueryError, stateText } from "../status.tsx";
import { Badge } from "../ui/badge.tsx";

// Solo tipos de @lunasq/schemas: importar sus valores mete zod en el bundle.
const TRANSITIONED: typeof TASK_TRANSITIONED = "task.transitioned";
const TEST_GATE: typeof TEST_GATE_EXECUTED = "test_gate.executed";

const PRE = "max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs";

function TransitionDetail({ payload }: { payload: TaskTransitionedPayload }) {
  const extra = [payload.reason, payload.note].filter(Boolean).join(" · ");
  return (
    <>
      <span>{`${stateText(payload.from)} → ${stateText(payload.to)}`}</span>
      {extra && <span className="text-muted-foreground">{extra}</span>}
    </>
  );
}

function TestGateDetail({ payload }: { payload: TestGateExecutedPayload }) {
  const outcome = payload.passed ? "pasó" : payload.timedOut ? "excedió el tiempo" : "falló";
  const output = stripAnsi(payload.output);
  return (
    <>
      <span>{`Tests ${outcome}`}</span>
      <span className="text-muted-foreground">
        {`exit ${payload.exitCode ?? "—"} · ${payload.durationMs} ms`}
        {payload.command && ` · ${payload.command}`}
      </span>
      {payload.error && <span className="text-destructive">{stripAnsi(payload.error)}</span>}
      {output && (
        <details className="w-full">
          <summary className="cursor-pointer text-xs text-muted-foreground">Salida</summary>
          <pre className={`mt-1 ${PRE}`}>{output}</pre>
        </details>
      )}
    </>
  );
}

function Detail({ event }: { event: Json<EventView> }) {
  if (event.type === TRANSITIONED) {
    return <TransitionDetail payload={event.payload as TaskTransitionedPayload} />;
  }
  if (event.type === TEST_GATE) {
    return <TestGateDetail payload={event.payload as TestGateExecutedPayload} />;
  }
  if (event.payload === null || event.payload === undefined) return null;
  return (
    <details className="w-full">
      <summary className="cursor-pointer text-xs text-muted-foreground">Datos</summary>
      <pre className={`mt-1 ${PRE}`}>{JSON.stringify(event.payload, null, 2)}</pre>
    </details>
  );
}

export function EventLogPanel({ taskId }: { taskId: string }) {
  const events = useQuery(queries.events(taskId));
  const count = events.data?.length;
  return (
    <Section title="Event log">
      {events.error ? (
        <QueryError error={events.error} />
      ) : !events.data ? (
        <Loading />
      ) : events.data.length === 0 ? (
        <Muted>Sin eventos.</Muted>
      ) : (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {`Mostrar ${count} ${count === 1 ? "evento" : "eventos"}`}
          </summary>
          <ol className="mt-3 flex flex-col gap-3 text-sm">
            {events.data.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-baseline gap-2 border-b pb-3 last:border-b-0"
              >
                <time className="text-xs text-muted-foreground" dateTime={event.createdAt}>
                  {formatDate(event.createdAt)}
                </time>
                <Badge variant="outline">{event.actor}</Badge>
                <span className="font-mono text-xs">{event.type}</span>
                <Detail event={event} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </Section>
  );
}
