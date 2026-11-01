// Pestaña En curso: las tareas en In progress y cualquier tarea con un agente corriendo (sub-estado running), de todos los proyectos.
// Lee la lista de tareas, así que el stream en vivo la refresca al invalidar ["tasks"].
import type { RunView, Task } from "@lunasq/schemas";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { DataTable } from "../components/data-table.tsx";
import { Loading, QueryError } from "../components/status.tsx";
import { TaskNumber } from "../components/task-number.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Label, Select } from "../components/ui/input.tsx";
import type { Json } from "../lib/api.ts";
import { formatAgent, SUB_STATE_LABEL, taskLabel } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";

type Row = Json<Task>;
type Run = Json<RunView>;
const column = createColumnHelper<Row>();

/** El último Run por startedAt: el abierto si hay agente corriendo. */
function latestRun(runs: Run[]): Run | undefined {
  return runs.reduce<Run | undefined>(
    (latest, run) =>
      !latest || Date.parse(run.startedAt) >= Date.parse(latest.startedAt) ? run : latest,
    undefined,
  );
}

/** «…» mientras cargan los Runs de la tarea; «—» si no tiene ninguno. */
function runCell(run: Run | null | undefined, format: (run: Run) => string): string {
  if (run === undefined) return "…";
  return run ? format(run) : "—";
}

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
  // Un query por tarea, con la misma clave que el panel de Runs: el stream en vivo la invalida
  // junto con ["task", id], así que las columnas de Run se refrescan solas.
  // `undefined` mientras cargan los Runs de la tarea; `null` si no tiene ninguno o la consulta falló.
  const latestRuns = useQueries({
    queries: (inProgress ?? []).map((t) => queries.runs(t.id)),
    combine: (results) => {
      const byTask = new Map<string, Run | null | undefined>();
      (inProgress ?? []).forEach((t, i) => {
        const result = results[i];
        byTask.set(
          t.id,
          result?.data ? (latestRun(result.data) ?? null) : result?.isPending ? undefined : null,
        );
      });
      return byTask;
    },
  });

  const columns = useMemo(
    () => [
      column.accessor(taskLabel, {
        id: "intent",
        header: "Tarea",
        cell: (c) => (
          <span className="flex items-baseline gap-2">
            <TaskNumber number={c.row.original.number} />
            <Link
              to="/tasks/$taskId"
              params={{ taskId: c.row.original.id }}
              className="font-medium hover:underline"
            >
              {c.getValue()}
            </Link>
          </span>
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
      // Columnas de display: TanStack Table cachea el valor de los accessors por fila mientras
      // `data` no cambie, y los Runs llegan después de la lista de tareas.
      column.display({
        id: "iteration",
        header: "Iteración",
        cell: (c) => runCell(latestRuns.get(c.row.original.id), (r) => String(r.iteration)),
      }),
      column.display({
        id: "agent",
        header: "Agente",
        cell: (c) => runCell(latestRuns.get(c.row.original.id), formatAgent),
      }),
      column.display({
        id: "pane",
        header: "Pane",
        cell: (c) => runCell(latestRuns.get(c.row.original.id), (r) => r.herdrPane ?? "—"),
      }),
    ],
    [names, latestRuns],
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
