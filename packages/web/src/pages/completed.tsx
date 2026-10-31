// Tareas completadas de todos los proyectos; el filtro permite enfocarse en uno.
import type { Task } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { DataTable } from "../components/data-table.tsx";
import { Loading, QueryError } from "../components/status.tsx";
import { Label, Select } from "../components/ui/input.tsx";
import type { Json } from "../lib/api.ts";
import { taskLabel } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";

type Row = Json<Task>;
const column = createColumnHelper<Row>();

export function CompletedPage() {
  const [projectId, setProjectId] = useState("");
  const projects = useQuery(queries.projects());
  const tasks = useQuery(queries.tasks(projectId || undefined));
  const names = useMemo(
    () => new Map((projects.data ?? []).map((project) => [project.id, project.name])),
    [projects.data],
  );
  const completed = useMemo(
    () => tasks.data?.filter((task) => task.state === "completed"),
    [tasks.data],
  );

  const columns = useMemo(
    () => [
      column.accessor(taskLabel, {
        id: "intent",
        header: "Tarea",
        cell: (cell) => (
          <Link
            to="/tasks/$taskId"
            params={{ taskId: cell.row.original.id }}
            className="font-medium hover:underline"
          >
            {cell.getValue()}
          </Link>
        ),
      }),
      column.accessor((task) => names.get(task.projectId) ?? "…", {
        id: "project",
        header: "Proyecto",
      }),
      column.accessor("priority", { header: "Prioridad" }),
      column.accessor((task) => task.prState ?? "—", {
        id: "pr",
        header: "PR",
        cell: (cell) => {
          const task = cell.row.original;
          return task.prUrl ? (
            <a href={task.prUrl} target="_blank" rel="noreferrer" className="underline">
              {`PR ${cell.getValue()}`}
            </a>
          ) : (
            cell.getValue()
          );
        },
      }),
    ],
    [names],
  );

  const error = projects.error ?? tasks.error;
  if (error) return <QueryError error={error} />;
  if (!projects.data || !completed) return <Loading />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-semibold">Completed</h1>
        <div className="flex w-64 flex-col gap-1">
          <Label htmlFor="completed-project">Proyecto</Label>
          <Select
            id="completed-project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Todos</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <DataTable
        columns={columns}
        data={completed}
        getRowId={(task) => task.id}
        empty="No hay tareas completadas."
      />
    </div>
  );
}
