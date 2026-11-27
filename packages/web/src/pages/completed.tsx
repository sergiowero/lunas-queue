// Completed tasks across all projects; the filter lets you focus on one.

import { PrState, type Task } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { DataTable } from "../components/data-table.tsx";
import { ExternalLinkIcon } from "../components/external-link-icon.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { Pagination } from "../components/pagination.tsx";
import { ProjectLabel } from "../components/project-label.tsx";
import { Loading, QueryError } from "../components/status.tsx";
import { TaskNumber } from "../components/task-number.tsx";
import { Time } from "../components/time.tsx";
import { buttonVariants } from "../components/ui/button.tsx";
import { Label, Select } from "../components/ui/input.tsx";
import type { Json } from "../lib/api.ts";
import { useDocumentTitle } from "../lib/document-title.ts";
import { cappedTaskLabel, fullLabelTitle } from "../lib/format.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";
import { useProjectFilter, useTabFilters } from "../lib/tab-filters.tsx";

type Row = Json<Task>;
const column = createColumnHelper<Row>();

// Selector value for completed tasks without a PR (prState null).
const NO_PR = "none";

// Rows shown at once in the Research section and inside the collapsible Rest.
const PAGE_SIZE = 20;

export function CompletedPage() {
  const t = useT();
  useDocumentTitle(t.completedPage.title);
  const [filters, setFilters] = useTabFilters("completed");
  const { prFilter } = filters;
  const [researchPage, setResearchPage] = useState(0);
  const [restPage, setRestPage] = useState(0);
  const projects = useQuery(queries.projects());
  const projectId = useProjectFilter("completed", projects.data);
  const tasks = useQuery(queries.tasks(projectId || undefined));
  const byId = useMemo(
    () => new Map((projects.data ?? []).map((project) => [project.id, project])),
    [projects.data],
  );
  // Every completed task that passes the filters falls into exactly one of the three lists.
  const lists = useMemo(() => {
    if (!tasks.data) return undefined;
    const completed = tasks.data.filter(
      (task) =>
        task.state === "completed" &&
        (prFilter === "" ||
          (prFilter === NO_PR ? task.prState === null : task.prState === prFilter)),
    );
    // Most recently completed first: what the human just finished is what they look for.
    completed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const isResearch = (task: Row) => task.resultKind === "research";
    return {
      open: completed.filter((task) => task.prState === "open" && !isResearch(task)),
      research: completed.filter(isResearch),
      rest: completed.filter((task) => task.prState !== "open" && !isResearch(task)),
    };
  }, [tasks.data, prFilter]);

  const columns = useMemo(
    () => [
      column.accessor(cappedTaskLabel, {
        id: "goal",
        header: t.columns.task,
        cell: (cell) => (
          <span className="flex min-w-48 items-baseline gap-2">
            <TaskNumber number={cell.row.original.number} />
            <Link
              to="/tasks/$taskId"
              params={{ taskId: cell.row.original.id }}
              className="font-medium transition-colors hover:text-primary-text hover:underline"
              title={fullLabelTitle(cell.row.original)}
            >
              {cell.getValue()}
            </Link>
          </span>
        ),
      }),
      // The accessor stays the project's name: it is what the column sorts and filters by.
      column.accessor((task) => byId.get(task.projectId)?.name ?? "…", {
        id: "project",
        header: t.columns.project,
        cell: (cell) => {
          const project = byId.get(cell.row.original.projectId);
          return project ? (
            <ProjectLabel name={project.name} icon={project.icon} color={project.color} />
          ) : (
            cell.getValue()
          );
        },
      }),
      column.accessor("priority", { header: t.columns.priority }),
      column.display({
        id: "completedAt",
        header: t.completedPage.completedAt,
        cell: (cell) => <Time iso={cell.row.original.updatedAt} />,
      }),
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
    [byId, t],
  );

  const error = projects.error ?? tasks.error;
  if (error) return <QueryError error={error} />;
  if (!projects.data || !lists) return <Loading />;

  const researchPageCount = Math.ceil(lists.research.length / PAGE_SIZE);
  const currentResearchPage = Math.min(researchPage, Math.max(researchPageCount - 1, 0));
  const researchRows = lists.research.slice(
    currentResearchPage * PAGE_SIZE,
    (currentResearchPage + 1) * PAGE_SIZE,
  );
  const restPageCount = Math.ceil(lists.rest.length / PAGE_SIZE);
  const currentRestPage = Math.min(restPage, Math.max(restPageCount - 1, 0));
  const restRows = lists.rest.slice(currentRestPage * PAGE_SIZE, (currentRestPage + 1) * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t.completedPage.title}>
        <div className="flex w-56 flex-col gap-1.5">
          <Label htmlFor="completed-project">{t.columns.project}</Label>
          <Select
            id="completed-project"
            value={projectId}
            onChange={(event) => {
              setFilters({ projectId: event.target.value });
              setResearchPage(0);
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
        <div className="flex w-56 flex-col gap-1.5">
          <Label htmlFor="completed-pr-state">{t.completedPage.prState}</Label>
          <Select
            id="completed-pr-state"
            value={prFilter}
            onChange={(event) => {
              setFilters({ prFilter: event.target.value });
              setResearchPage(0);
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
      </PageHeader>
      <section aria-labelledby="completed-open-heading" className="flex flex-col gap-2.5">
        <h2 id="completed-open-heading" className="text-[15px] font-semibold tracking-tight">
          {t.completedPage.withOpenPr}
        </h2>
        <DataTable
          columns={columns}
          data={lists.open}
          getRowId={(task) => task.id}
          empty={t.completedPage.emptyOpen}
        />
      </section>
      <section aria-labelledby="completed-research-heading" className="flex flex-col gap-2.5">
        <h2 id="completed-research-heading" className="text-[15px] font-semibold tracking-tight">
          {t.completedPage.research}
        </h2>
        <DataTable
          columns={columns}
          data={researchRows}
          getRowId={(task) => task.id}
          empty={t.completedPage.emptyResearch}
        />
        <Pagination
          page={currentResearchPage}
          pageCount={researchPageCount}
          onPageChange={setResearchPage}
        />
      </section>
      <details data-testid="completed-rest" className="card px-4 py-3">
        <summary className="cursor-pointer text-[15px] font-semibold tracking-tight">
          {t.completedPage.rest(lists.rest.length)}
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <DataTable
            columns={columns}
            data={restRows}
            getRowId={(task) => task.id}
            empty={t.completedPage.emptyRest}
          />
          <Pagination page={currentRestPage} pageCount={restPageCount} onPageChange={setRestPage} />
        </div>
      </details>
    </div>
  );
}
