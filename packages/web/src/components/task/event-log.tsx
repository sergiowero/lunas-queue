// Task Event log: who moved it, when and why (docs/design.md §Audit).
import type {
  EventView,
  TASK_TRANSITIONED,
  TaskTransitionedPayload,
  TEST_GATE_EXECUTED,
  TestGateExecutedPayload,
} from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import type { Json } from "../../lib/api.ts";
import { eventRun } from "../../lib/attribution.ts";
import { formatDate, stripAnsi } from "../../lib/format.ts";
import { useT } from "../../lib/i18n.ts";
import { queries } from "../../lib/queries.ts";
import { AgentBadge } from "../agent-badge.tsx";
import { Muted, Section } from "../section.tsx";
import { Loading, QueryError, stateText } from "../status.tsx";
import { Badge } from "../ui/badge.tsx";

// Types only from @lunasq/schemas: importing its values pulls zod into the bundle.
const TRANSITIONED: typeof TASK_TRANSITIONED = "task.transitioned";
const TEST_GATE: typeof TEST_GATE_EXECUTED = "test_gate.executed";

const PRE =
  "max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border-light bg-surface-secondary/70 p-3 font-mono text-xs";

function TransitionDetail({ payload }: { payload: TaskTransitionedPayload }) {
  const t = useT();
  const extra = [payload.reason, payload.note].filter(Boolean).join(" · ");
  return (
    <>
      <span>{`${stateText(payload.from, t)} → ${stateText(payload.to, t)}`}</span>
      {extra && <span className="text-muted-foreground">{extra}</span>}
    </>
  );
}

function TestGateDetail({ payload }: { payload: TestGateExecutedPayload }) {
  const t = useT();
  const outcome = payload.passed
    ? t.eventLog.testsPassed
    : payload.timedOut
      ? t.eventLog.testsTimedOut
      : t.eventLog.testsFailed;
  const output = stripAnsi(payload.output);
  return (
    <>
      <span>{t.eventLog.tests(outcome)}</span>
      <span className="text-muted-foreground">
        {`exit ${payload.exitCode ?? "—"} · ${payload.durationMs} ms`}
        {payload.command && ` · ${payload.command}`}
      </span>
      {payload.error && <span className="text-destructive">{stripAnsi(payload.error)}</span>}
      {output && (
        <details className="w-full">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {t.common.output}
          </summary>
          <pre className={`mt-1 ${PRE}`}>{output}</pre>
        </details>
      )}
    </>
  );
}

function Detail({ event }: { event: Json<EventView> }) {
  const t = useT();
  if (event.type === TRANSITIONED) {
    return <TransitionDetail payload={event.payload as TaskTransitionedPayload} />;
  }
  if (event.type === TEST_GATE) {
    return <TestGateDetail payload={event.payload as TestGateExecutedPayload} />;
  }
  if (event.payload === null || event.payload === undefined) return null;
  return (
    <details className="w-full">
      <summary className="cursor-pointer text-xs text-muted-foreground">{t.eventLog.data}</summary>
      <pre className={`mt-1 ${PRE}`}>{JSON.stringify(event.payload, null, 2)}</pre>
    </details>
  );
}

export function EventLogPanel({ taskId }: { taskId: string }) {
  const t = useT();
  const events = useQuery(queries.events(taskId));
  const runs = useQuery(queries.runs(taskId));
  const count = events.data?.length;
  // Newest first; the cached array (write order) must not be mutated.
  const newestFirst = events.data ? [...events.data].reverse() : [];
  return (
    <Section title={t.eventLog.title}>
      {events.error ? (
        <QueryError error={events.error} />
      ) : !events.data ? (
        <Loading />
      ) : events.data.length === 0 ? (
        <Muted>{t.eventLog.empty}</Muted>
      ) : (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t.eventLog.show(count ?? 0)}
          </summary>
          <ol className="relative mt-4 ml-1.5 flex flex-col gap-4 border-l border-border pl-5 text-sm">
            {newestFirst.map((event) => {
              // Only the agent's events are attributed: to the Run that was open when they happened.
              const run = eventRun(runs.data ?? [], event);
              return (
                <li key={event.id} className="relative flex flex-wrap items-baseline gap-2">
                  <span
                    aria-hidden="true"
                    className="absolute top-1.5 -left-[25px] size-2 rounded-full border-2 border-surface bg-border-strong ring-1 ring-border"
                  />
                  <time
                    className="text-xs text-muted-foreground tabular-nums"
                    dateTime={event.createdAt}
                  >
                    {formatDate(event.createdAt)}
                  </time>
                  <Badge variant="outline">{event.actor}</Badge>
                  {run && <AgentBadge profileId={run.profileId} kind={run.agentKind} />}
                  <span className="font-mono text-xs font-medium">{event.type}</span>
                  <Detail event={event} />
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </Section>
  );
}
