// Runs de la tarea (docs/design.md §Auditoría): cada intento por fase, con su motivo de fallo y
// el handoff que entregó el agente.
import type { RunView } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import type { Json } from "../../lib/api.ts";
import { formatDate, PHASE_LABEL, RESULT_LABEL } from "../../lib/format.ts";
import { queries } from "../../lib/queries.ts";
import { DataTable } from "../data-table.tsx";
import { Section } from "../section.tsx";
import { Loading, QueryError } from "../status.tsx";
import { Badge } from "../ui/badge.tsx";

type Run = Json<RunView>;
const column = createColumnHelper<Run>();

const columns = [
  column.accessor((r) => PHASE_LABEL[r.phase], { id: "phase", header: "Fase" }),
  column.accessor("iteration", { header: "Iteración" }),
  column.accessor((r) => (r.model ? `${r.agentKind} · ${r.model}` : r.agentKind), {
    id: "agent",
    header: "Agente",
  }),
  column.accessor((r) => r.herdrPane ?? "—", { id: "pane", header: "Pane" }),
  column.accessor((r) => formatDate(r.startedAt), { id: "started", header: "Inicio" }),
  column.accessor((r) => formatDate(r.endedAt), { id: "ended", header: "Fin" }),
  column.accessor("result", {
    header: "Resultado",
    cell: (c) => {
      const result = c.getValue();
      if (!result) return <Badge variant="outline">en curso</Badge>;
      return (
        <Badge variant={result === "failure" ? "destructive" : "secondary"}>
          {RESULT_LABEL[result]}
        </Badge>
      );
    },
  }),
  column.accessor("failureReason", {
    header: "Motivo del fallo",
    cell: (c) => <span className="whitespace-pre-wrap">{c.getValue() ?? ""}</span>,
  }),
  column.accessor("handoff", {
    header: "Handoff",
    cell: (c) => {
      const handoff = c.getValue();
      if (handoff === null || handoff === undefined) return null;
      return (
        <details>
          <summary className="cursor-pointer text-xs">JSON</summary>
          <pre className="max-w-md overflow-x-auto text-xs">{JSON.stringify(handoff, null, 2)}</pre>
        </details>
      );
    },
  }),
];

export function RunsPanel({ taskId }: { taskId: string }) {
  const runs = useQuery(queries.runs(taskId));
  return (
    <Section title="Runs">
      {runs.error ? (
        <QueryError error={runs.error} />
      ) : runs.isPending ? (
        <Loading />
      ) : (
        <DataTable
          columns={columns}
          data={runs.data ?? []}
          getRowId={(r) => r.id}
          empty="Todavía no hay Runs."
        />
      )}
    </Section>
  );
}
