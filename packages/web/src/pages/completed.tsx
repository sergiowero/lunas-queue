// Tareas completadas de todos los proyectos; el filtro permite enfocarse en uno.
import { PrState, type Task } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { DataTable } from "../components/data-table.tsx";
import { ExternalLinkIcon } from "../components/external-link-icon.tsx";
import { Pagination } from "../components/pagination.tsx";
import { Loading, QueryError } from "../components/status.tsx";
import { TaskNumber } from "../components/task-number.tsx";
import { buttonVariants } from "../components/ui/button.tsx";
import { Label, Select } from "../components/ui/input.tsx";
import type { Json } from "../lib/api.ts";
import { RESULT_KIND_LABEL, taskLabel } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";

type Row = Json<Task>;
const column = createColumnHelper<Row>();

// Valor del selector para las tareas completadas sin PR (prState null).
const NO_PR = "none";

// Filas del resto que se muestran a la vez dentro de la sección colapsable.
const REST_PAGE_SIZE = 20;

export function CompletedPage() {
  const [projectId, setProjectId] = useState("");
  const [prFilter, setPrFilter] = useState("");
  const [restPage, setRestPage] = useState(0);
  const projects = useQuery(queries.projects());
  const tasks = useQuery(queries.tasks(projectId || undefined));
  const names = useMemo(
    () => new Map((projects.data ?? []).map((project) => [project.id, project.name])),
    [projects.data],
  );
  // Toda tarea completada que pasa los filtros cae en exactamente una de las dos listas.
  const lists = useMemo(() => {
    if (!tasks.data) return undefined;
    const completed = tasks.data.filter(
      (task) =>
        task.state === "completed" &&
        (prFilter === "" ||
          (prFilter === NO_PR ? task.prState === null : task.prState === prFilter)),
    );
    return {
      open: completed.filter((task) => task.prState === "open"),
      rest: completed.filter((task) => task.prState !== "open"),
    };
  }, [tasks.data, prFilter]);

  const columns = useMemo(
    () => [
      column.accessor(taskLabel, {
        id: "intent",
        header: "Tarea",
        cell: (cell) => (
          <span className="flex items-baseline gap-2">
            <TaskNumber number={cell.row.original.number} />
            <Link
              to="/tasks/$taskId"
              params={{ taskId: cell.row.original.id }}
              className="font-medium hover:underline"
            >
              {cell.getValue()}
            </Link>
          </span>
        ),
      }),
      column.accessor((task) => names.get(task.projectId) ?? "…", {
        id: "project",
        header: "Proyecto",
      }),
      column.accessor("priority", { header: "Prioridad" }),
      // Sin PR: una tarea completada con Resultado muestra su tipo en lugar del PR.
      column.accessor(
        (task) => (task.resultKind ? RESULT_KIND_LABEL[task.resultKind] : (task.prState ?? "—")),
        {
          id: "pr",
          header: "PR",
          cell: (cell) => {
            const task = cell.row.original;
            return task.prUrl ? (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {`PR ${cell.getValue()}`}
                <ExternalLinkIcon />
              </a>
            ) : (
              cell.getValue()
            );
          },
        },
      ),
    ],
    [names],
  );

  const error = projects.error ?? tasks.error;
  if (error) return <QueryError error={error} />;
  if (!projects.data || !lists) return <Loading />;

  const pageCount = Math.ceil(lists.rest.length / REST_PAGE_SIZE);
  const page = Math.min(restPage, Math.max(pageCount - 1, 0));
  const restRows = lists.rest.slice(page * REST_PAGE_SIZE, (page + 1) * REST_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-semibold">Completed</h1>
        <div className="flex flex-wrap gap-4">
          <div className="flex w-64 flex-col gap-1">
            <Label htmlFor="completed-project">Proyecto</Label>
            <Select
              id="completed-project"
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setRestPage(0);
              }}
            >
              <option value="">Todos</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex w-64 flex-col gap-1">
            <Label htmlFor="completed-pr-state">Estado del PR</Label>
            <Select
              id="completed-pr-state"
              value={prFilter}
              onChange={(event) => {
                setPrFilter(event.target.value);
                setRestPage(0);
              }}
            >
              <option value="">Todos</option>
              {PrState.options.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
              <option value={NO_PR}>Sin PR</option>
            </Select>
          </div>
        </div>
      </div>
      <section aria-labelledby="completed-open-heading" className="flex flex-col gap-2">
        <h2 id="completed-open-heading" className="text-base font-semibold">
          Con PR abierto
        </h2>
        <DataTable
          columns={columns}
          data={lists.open}
          getRowId={(task) => task.id}
          empty="No hay tareas completadas con PR abierto."
        />
      </section>
      <details data-testid="completed-rest" className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-base font-semibold">
          Resto ({lists.rest.length})
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <DataTable
            columns={columns}
            data={restRows}
            getRowId={(task) => task.id}
            empty="No hay otras tareas completadas."
          />
          <Pagination page={page} pageCount={pageCount} onPageChange={setRestPage} />
        </div>
      </details>
    </div>
  );
}
