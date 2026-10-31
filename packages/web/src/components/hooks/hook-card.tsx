import type { HookExecutionView, HookView } from "@lunasq/schemas";
import { Link } from "@tanstack/react-router";
import type { Json } from "../../lib/api.ts";
import { formatDate, formatDuration, formatTimeout } from "../../lib/format.ts";
import { Muted } from "../section.tsx";
import { Badge } from "../ui/badge.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.tsx";

type Execution = Json<HookExecutionView>;

function ExecutionRow({ execution: e }: { execution: Execution }) {
  return (
    <TableRow>
      <TableCell>
        <Link to="/tasks/$taskId" params={{ taskId: e.taskId }} className="hover:underline">
          {e.taskTitle ?? e.taskIntent}
        </Link>
      </TableCell>
      <TableCell>{formatDate(e.at)}</TableCell>
      <TableCell>
        <span className="inline-flex gap-1">
          <Badge variant={e.passed ? "secondary" : "destructive"}>exit {e.exitCode}</Badge>
          {e.timedOut && <Badge variant="destructive">timeout</Badge>}
        </span>
      </TableCell>
      <TableCell>{formatDuration(e.durationMs)}</TableCell>
      <TableCell>
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Salida</summary>
          <pre className="max-h-64 overflow-auto text-xs whitespace-pre-wrap">
            {e.output || "(sin salida)"}
          </pre>
        </details>
      </TableCell>
    </TableRow>
  );
}

/** Lo que la tarjeta sabe de las ejecuciones: cargando, fallo de la consulta o la lista. */
export type ExecutionsState = Execution[] | "loading" | "failed";

function Executions({ executions }: { executions: ExecutionsState }) {
  if (executions === "loading") return <Muted>Cargando ejecuciones…</Muted>;
  if (executions === "failed") return <Muted>No se pudieron cargar las ejecuciones.</Muted>;
  if (executions.length === 0) return <Muted>Sin ejecuciones.</Muted>;
  // El servidor ya deja la ejecución más reciente de cada tarea en este script.
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Tarea</TableHead>
          <TableHead>Cuándo</TableHead>
          <TableHead>Resultado</TableHead>
          <TableHead>Duración</TableHead>
          <TableHead>Salida</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {executions.map((e) => (
          <ExecutionRow key={e.eventId} execution={e} />
        ))}
      </TableBody>
    </Table>
  );
}

/** Un script de la rama base (o, sin `hook`, uno que ya no está) con sus últimas ejecuciones. */
export function HookCard({
  script,
  hook,
  executions,
}: {
  script: string;
  hook: Json<HookView> | null;
  executions: ExecutionsState;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: un fieldset no aplica, esto no es un formulario.
    <div
      role="group"
      aria-label={script}
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-sm font-medium">{script}</h3>
        {hook ? (
          <>
            <Badge variant={hook.policy === "block" ? "destructive" : "secondary"}>
              {hook.policy}
            </Badge>
            <Badge variant="outline">{formatTimeout(hook.timeoutSeconds)}</Badge>
          </>
        ) : (
          <Badge variant="outline">ya no está en la rama base</Badge>
        )}
      </div>
      {hook && (
        <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{hook.content}</pre>
      )}
      <Executions executions={executions} />
    </div>
  );
}
