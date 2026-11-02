// Completed tasks across all projects; the filter lets you focus on one.
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
import { cappedTaskLabel } from "../lib/format.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";

type Row = Json<Task>;
const column = createColumnHelper<Row>();

// Selector value for completed tasks without a PR (prState null).
const NO_PR = "none";

// Rest rows shown at once inside the collapsible section.
const REST_PAGE_SIZE = 20;

export function CompletedPage() {
  const t = useT();
  const [projectId, setProjectId] = useState("");
  const [prFilter, setPrFilter] = useState("");
  const [restPage, setRestPage] = useState(0);
  const projects = useQuery(queries.projects());
  const tasks = useQuery(queries.tasks(projectId || undefined));
  const names = useMemo(
    () => new Map((projects.data ?? []).map((project) => [project.id, project.name])),
    [projects.data],
  );
  // Every completed task that passes the filters falls into exactly one of the two lists.
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
      column.accessor(cappedTaskLabel, {
        id: "intent",
        header: t.columns.task,
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
        header: t.columns.project,
      }),
      column.accessor("priority", { header: t.columns.priority }),
      // Without a PR: a completed task with a Result shows its type instead of the PR.
      // A display column: the label depends on the language and TanStack Table would cache
      // an accessor's value per row.
      column.display({
        id: "pr",
        header: t.completedPage.pr,
        cell: (cell) => {
          const task = cell.row.original;
          const label = task.resultKind ? t.resultKind[task.resultKind] : (task.prState ?? "—");
          return task.prUrl ? (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {t.completedPage.prButton(label)}
              <ExternalLinkIcon />
            </a>
          ) : (
            label
          );
        },
      }),
    ],
    [names, t],
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
        <h1 className="text-xl font-semibold">{t.completedPage.title}</h1>
        <div className="flex flex-wrap gap-4">
          <div className="flex w-64 flex-col gap-1">
            <Label htmlFor="completed-project">{t.columns.project}</Label>
            <Select
              id="completed-project"
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setRestPage(0);
              }}
            >
              <option value="">{t.allProjects}</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex w-64 flex-col gap-1">
            <Label htmlFor="completed-pr-state">{t.completedPage.prState}</Label>
            <Select
              id="completed-pr-state"
              value={prFilter}
              onChange={(event) => {
                setPrFilter(event.target.value);
                setRestPage(0);
              }}
            >
              <option value="">{t.allProjects}</option>
              {PrState.options.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
              <option value={NO_PR}>{t.completedPage.noPr}</option>
            </Select>
          </div>
        </div>
      </div>
      <section aria-labelledby="completed-open-heading" className="flex flex-col gap-2">
        <h2 id="completed-open-heading" className="text-base font-semibold">
          {t.completedPage.withOpenPr}
        </h2>
        <DataTable
          columns={columns}
          data={lists.open}
          getRowId={(task) => task.id}
          empty={t.completedPage.emptyOpen}
        />
      </section>
      <details data-testid="completed-rest" className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-base font-semibold">
          {t.completedPage.rest(lists.rest.length)}
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <DataTable
            columns={columns}
            data={restRows}
            getRowId={(task) => task.id}
            empty={t.completedPage.emptyRest}
          />
          <Pagination page={page} pageCount={pageCount} onPageChange={setRestPage} />
        </div>
      </details>
    </div>
  );
}
