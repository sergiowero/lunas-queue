// Runs de la tarea (docs/design.md §Auditoría): cada intento por fase, con su motivo de fallo y
// el handoff que entregó el agente.
import type { RunView } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { useState } from "react";
import type { Json } from "../../lib/api.ts";
import { formatAgent, formatDate, PHASE_LABEL, RESULT_LABEL } from "../../lib/format.ts";
import { queries } from "../../lib/queries.ts";
import { DataTable } from "../data-table.tsx";
import { PAGE_SIZE, Pagination } from "../pagination.tsx";
import { Section } from "../section.tsx";
import { Loading, QueryError } from "../status.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { HandoffDialog } from "./handoff-dialog.tsx";

type Run = Json<RunView>;
const column = createColumnHelper<Run>();

function HandoffCell({ handoff }: { handoff: Run["handoff"] }) {
  const [isOpen, setIsOpen] = useState(false);
  if (handoff === null || handoff === undefined) return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setIsOpen(true)}>
        Abrir handoff
      </Button>
      {isOpen && <HandoffDialog handoff={handoff} onClose={() => setIsOpen(false)} />}
    </>
  );
}

const columns = [
  column.accessor((r) => PHASE_LABEL[r.phase], { id: "phase", header: "Fase" }),
  column.accessor("iteration", { header: "Iteración" }),
  column.accessor(formatAgent, { id: "agent", header: "Agente" }),
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
    cell: (c) => <HandoffCell handoff={c.getValue()} />,
  }),
];

export function RunsPanel({ taskId }: { taskId: string }) {
  const runs = useQuery(queries.runs(taskId));
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  const data = runs.data ?? [];
  const pageCount = Math.ceil(data.length / PAGE_SIZE);
  const page = Math.min(selectedPage ?? Math.max(0, pageCount - 1), Math.max(0, pageCount - 1));
  return (
    <Section title="Runs">
      {runs.error ? (
        <QueryError error={runs.error} />
      ) : runs.isPending ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-3">
          <DataTable
            columns={columns}
            data={data.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)}
            getRowId={(r) => r.id}
            empty="Todavía no hay Runs."
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            onPageChange={(nextPage) =>
              setSelectedPage(nextPage === pageCount - 1 ? null : nextPage)
            }
          />
        </div>
      )}
    </Section>
  );
}
