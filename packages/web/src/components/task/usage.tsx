// Consumo de la tarea (docs/design.md §Consumo): read-only, lo escribe el usage collector (UW-20).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { formatCost, formatTokens, PHASE_LABEL } from "../../lib/format.ts";
import { queries } from "../../lib/queries.ts";
import { PAGE_SIZE, Pagination } from "../pagination.tsx";
import { Muted, Section } from "../section.tsx";
import { Loading, QueryError } from "../status.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.tsx";

export function UsagePanel({ taskId }: { taskId: string }) {
  const usage = useQuery(queries.usage(taskId));
  const runs = useQuery(queries.runs(taskId));
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  if (usage.error) {
    return (
      <Section title="Usage">
        <QueryError error={usage.error} />
      </Section>
    );
  }
  if (runs.error) {
    return (
      <Section title="Usage">
        <QueryError error={runs.error} />
      </Section>
    );
  }
  const data = usage.data;
  const recorded = new Map(data?.byRun.map((entry) => [entry.runId, entry]));
  const runRows =
    runs.data?.map((run) => ({
      runId: run.id,
      phase: run.phase,
      agentKind: run.agentKind,
      usage: recorded.get(run.id)?.usage,
    })) ?? data?.byRun.map((entry) => ({ ...entry, agentKind: undefined }));
  const unavailableCopilot = runRows?.some(
    (run) => run.agentKind === "copilot" && run.usage === undefined,
  );
  const pageCount = Math.ceil((runRows?.length ?? 0) / PAGE_SIZE);
  const page = Math.min(selectedPage ?? Math.max(0, pageCount - 1), Math.max(0, pageCount - 1));
  const pageRows = runRows?.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return (
    <Section title="Usage">
      {!data ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">
            {`${unavailableCopilot ? "Consumo registrado (parcial: Copilot CLI no informa usage): " : ""}${formatTokens(data.total)} tokens · ${formatCost(data.total.costUsd)}`}
          </p>
          {runRows?.length === 0 ? (
            <Muted>Sin consumo registrado todavía.</Muted>
          ) : (
            <div className="flex flex-col gap-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fase</TableHead>
                    <TableHead>Entrada</TableHead>
                    <TableHead>Salida</TableHead>
                    <TableHead>Caché (lectura / escritura)</TableHead>
                    <TableHead>Costo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows?.map(({ runId, phase, usage: u }) => (
                    <TableRow key={runId}>
                      <TableCell>{PHASE_LABEL[phase]}</TableCell>
                      <TableCell>{u?.inputTokens ?? "No disponible"}</TableCell>
                      <TableCell>{u?.outputTokens ?? "No disponible"}</TableCell>
                      <TableCell>
                        {u ? `${u.cacheReadTokens} / ${u.cacheWriteTokens}` : "No disponible"}
                      </TableCell>
                      <TableCell>{u ? formatCost(u.costUsd) : "No disponible"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                page={page}
                pageCount={pageCount}
                onPageChange={(nextPage) =>
                  setSelectedPage(nextPage === pageCount - 1 ? null : nextPage)
                }
              />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
