// Consumo de la tarea (docs/design.md §Consumo): read-only, lo escribe el usage collector (UW-20).
import { useQuery } from "@tanstack/react-query";
import { formatCost, formatTokens, PHASE_LABEL } from "../../lib/format.ts";
import { queries } from "../../lib/queries.ts";
import { Muted, Section } from "../section.tsx";
import { QueryError } from "../status.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.tsx";

export function UsagePanel({ taskId }: { taskId: string }) {
  const usage = useQuery(queries.usage(taskId));
  if (usage.error) {
    return (
      <Section title="Usage">
        <QueryError error={usage.error} />
      </Section>
    );
  }
  const data = usage.data;
  return (
    <Section title="Usage">
      {data && (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">{`${formatTokens(data.total)} tokens · ${formatCost(data.total.costUsd)}`}</p>
          {data.byRun.length === 0 ? (
            <Muted>Sin consumo registrado todavía.</Muted>
          ) : (
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
                {data.byRun.map(({ runId, phase, usage: u }) => (
                  <TableRow key={runId}>
                    <TableCell>{PHASE_LABEL[phase]}</TableCell>
                    <TableCell>{u.inputTokens}</TableCell>
                    <TableCell>{u.outputTokens}</TableCell>
                    <TableCell>{`${u.cacheReadTokens} / ${u.cacheWriteTokens}`}</TableCell>
                    <TableCell>{formatCost(u.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </Section>
  );
}
