// Cola global (docs/design.md §Front end): el ready set en el orden del scheduler y después las
// demás tareas vivas. El score y el usage los calcula el servidor.
import type { QueueEntry } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { DataTable } from "../components/data-table.tsx";
import { Loading, QueryError, StateBadges, stateText } from "../components/status.tsx";
import { Label, Select } from "../components/ui/input.tsx";
import type { Json } from "../lib/api.ts";
import { formatCost, formatTokens, taskLabel } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";

type Entry = Json<QueueEntry>;
const column = createColumnHelper<Entry>();

function score(entry: Entry): string {
  return entry.score === null ? "—" : String(Math.round(entry.score * 10) / 10);
}

function priority(entry: Entry): string {
  const base = entry.task.priority;
  return entry.effectivePriority !== null && entry.effectivePriority !== base
    ? `${base} → ${entry.effectivePriority}`
    : String(base);
}

export function QueuePage() {
  const [projectId, setProjectId] = useState("");
  const projects = useQuery(queries.projects());
  const queue = useQuery(queries.queue(projectId || undefined));
  const names = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.name])),
    [projects.data],
  );

  const columns = useMemo(
    () => [
      column.display({ id: "position", header: "#", cell: (c) => c.row.index + 1 }),
      column.accessor((e) => taskLabel(e.task), {
        id: "intent",
        header: "Tarea",
        cell: (c) => (
          <Link
            to="/tasks/$taskId"
            params={{ taskId: c.row.original.task.id }}
            className="font-medium hover:underline"
          >
            {c.getValue()}
          </Link>
        ),
      }),
      column.accessor((e) => names.get(e.task.projectId) ?? "…", {
        id: "project",
        header: "Proyecto",
      }),
      column.accessor((e) => stateText(e.task), {
        id: "state",
        header: "Estado",
        cell: (c) => (
          <StateBadges state={c.row.original.task.state} subState={c.row.original.task.subState} />
        ),
      }),
      column.accessor(priority, { id: "priority", header: "Prioridad" }),
      column.accessor(score, { id: "score", header: "Score" }),
      column.accessor((e) => `${formatTokens(e.usage)} · ${formatCost(e.usage.costUsd)}`, {
        id: "usage",
        header: "Usage",
      }),
    ],
    [names],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-semibold">Cola global</h1>
        <div className="flex w-64 flex-col gap-1">
          <Label htmlFor="queue-project">Proyecto</Label>
          <Select
            id="queue-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Todos</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {queue.error ? (
        <QueryError error={queue.error} />
      ) : queue.data ? (
        <DataTable
          columns={columns}
          data={queue.data}
          getRowId={(e) => e.task.id}
          empty="No hay tareas vivas en la cola."
        />
      ) : (
        <Loading />
      )}
    </div>
  );
}
