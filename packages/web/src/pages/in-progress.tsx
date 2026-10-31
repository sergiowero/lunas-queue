// Pestaña En curso: las tareas en In progress y cualquier tarea con un agente corriendo (sub-estado running), de todos los proyectos.
// Lee la lista de tareas, así que el stream en vivo la refresca al invalidar ["tasks"].
import type { Task } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { DataTable } from "../components/data-table.tsx";
import { Loading, QueryError } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Label, Select } from "../components/ui/input.tsx";
import type { Json } from "../lib/api.ts";
import { SUB_STATE_LABEL, taskLabel } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";

type Row = Json<Task>;
const column = createColumnHelper<Row>();

export function InProgressPage() {
  const [projectId, setProjectId] = useState("");
  const projects = useQuery(queries.projects());
  const tasks = useQuery(queries.tasks(projectId || undefined));
  const names = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.name])),
    [projects.data],
  );
  const inProgress = useMemo(
    () => tasks.data?.filter((t) => t.state === "in_progress" || t.subState === "running"),
    [tasks.data],
  );

  const columns = useMemo(
    () => [
      column.accessor(taskLabel, {
        id: "intent",
        header: "Tarea",
        cell: (c) => (
          <Link
            to="/tasks/$taskId"
            params={{ taskId: c.row.original.id }}
            className="font-medium hover:underline"
          >
            {c.getValue()}
          </Link>
        ),
      }),
      column.accessor((t) => names.get(t.projectId) ?? "…", { id: "project", header: "Proyecto" }),
      column.accessor("subState", {
        header: "Sub-estado",
        cell: (c) => {
          const subState = c.getValue();
          return subState ? <Badge variant="outline">{SUB_STATE_LABEL[subState]}</Badge> : "—";
        },
      }),
      column.accessor("priority", { header: "Prioridad" }),
    ],
    [names],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-semibold">En curso</h1>
        <div className="flex w-64 flex-col gap-1">
          <Label htmlFor="in-progress-project">Proyecto</Label>
          <Select
            id="in-progress-project"
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
      {tasks.error ? (
        <QueryError error={tasks.error} />
      ) : inProgress ? (
        <DataTable
          columns={columns}
          data={inProgress}
          getRowId={(t) => t.id}
          empty="No hay tareas en curso."
        />
      ) : (
        <Loading />
      )}
    </div>
  );
}
