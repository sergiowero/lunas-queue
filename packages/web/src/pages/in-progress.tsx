// In progress tab: tasks in In progress and any task with a running agent (running sub-state), across all projects.
// It reads the task list, so the live stream refreshes it when ["tasks"] is invalidated.
import type { RunView, Task } from "@lunasq/schemas";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type CellContext, createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { DataTable } from "../components/data-table.tsx";
import { PaneFocusButton } from "../components/pane-focus-button.tsx";
import { Loading, QueryError, StateBadges, stateText } from "../components/status.tsx";
import { PauseTaskButton } from "../components/task-actions.tsx";
import { TaskNumber } from "../components/task-number.tsx";
import { Label, Select } from "../components/ui/input.tsx";
import type { Json } from "../lib/api.ts";
import { canPause, cappedTaskLabel, formatAgent } from "../lib/format.ts";
import { useT } from "../lib/i18n.ts";
import { isInProgress } from "../lib/in-progress.ts";
import { queries } from "../lib/queries.ts";
import { useTabFilters, validProjectId } from "../lib/tab-filters.tsx";

type Row = Json<Task>;
type Run = Json<RunView>;
const column = createColumnHelper<Row>();

/** The last Run by startedAt: the open one if an agent is running. */
function latestRun(runs: Run[]): Run | undefined {
  return runs.reduce<Run | undefined>(
    (latest, run) =>
      !latest || Date.parse(run.startedAt) >= Date.parse(latest.startedAt) ? run : latest,
    undefined,
  );
}

/** A task's Runs: loading, with an error, with none (`null`) or the most recent. */
type LatestRun = Run | null | "loading" | "error";

/** «…» while the task's Runs load; «error» if the query failed; «—» if it has none. */
function runCell(
  run: LatestRun | undefined,
  format: (run: Run) => string,
  errorLabel: string,
): string {
  if (run === undefined || run === "loading") return "…";
  if (run === "error") return errorLabel;
  return run ? format(run) : "—";
}

/**
 * Icon only: the accessible name carries the task. A paused task leaves the list on
 * refresh, so only pause is here. It is a module component (not an inline function):
 * the columns are recreated when the Runs arrive and a new cell would remount the button, losing its
 * pending state and its error.
 */
function ActionsCell({ row }: CellContext<Row, unknown>) {
  return canPause(row.original.state) ? (
    <PauseTaskButton task={row.original} variant="icon" />
  ) : null;
}

export function InProgressPage() {
  const t = useT();
  const [filters, setFilters] = useTabFilters("inProgress");
  const projects = useQuery(queries.projects());
  const projectId = validProjectId(filters.projectId, projects.data);
  const tasks = useQuery(queries.tasks(projectId || undefined));
  const names = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.name])),
    [projects.data],
  );
  const inProgress = useMemo(() => tasks.data?.filter(isInProgress), [tasks.data]);
  // One query per task, with the same key as the Runs panel: the live stream invalidates it
  // together with ["task", id], so the Run columns refresh on their own.
  // Distinguishes loading, query error and «no Runs» (`null`): a failure is not shown as empty.
  const latestRuns = useQueries({
    queries: (inProgress ?? []).map((t) => queries.runs(t.id)),
    combine: (results) => {
      const byTask = new Map<string, LatestRun>();
      (inProgress ?? []).forEach((t, i) => {
        const result = results[i];
        // The error wins over the cached data: a failed refetch keeps `data`, but the row
        // must say «error» and not offer to focus a pane that may no longer be the current one.
        byTask.set(
          t.id,
          result?.isError
            ? "error"
            : result?.data
              ? (latestRun(result.data) ?? null)
              : result?.isPending
                ? "loading"
                : "error",
        );
      });
      return byTask;
    },
  });

  const columns = useMemo(
    () => [
      column.accessor(cappedTaskLabel, {
        id: "intent",
        header: t.columns.task,
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
      column.accessor((t) => names.get(t.projectId) ?? "…", {
        id: "project",
        header: t.columns.project,
      }),
      column.accessor((task) => stateText(task, t), {
        id: "state",
        header: t.columns.state,
        cell: (c) => (
          <StateBadges state={c.row.original.state} subState={c.row.original.subState} />
        ),
      }),
      column.accessor("priority", { header: t.columns.priority }),
      // Display columns: TanStack Table caches the accessors' value per row while
      // `data` does not change, and the Runs arrive after the task list.
      column.display({
        id: "iteration",
        header: t.inProgressPage.iteration,
        cell: (c) =>
          runCell(
            latestRuns.get(c.row.original.id),
            (r) => String(r.iteration),
            t.inProgressPage.error,
          ),
      }),
      column.display({
        id: "agent",
        header: t.inProgressPage.agent,
        cell: (c) =>
          runCell(latestRuns.get(c.row.original.id), formatAgent, t.inProgressPage.error),
      }),
      column.display({
        id: "pane",
        header: t.inProgressPage.pane,
        cell: (c) => {
          const run = latestRuns.get(c.row.original.id);
          return typeof run === "object" && run ? (
            <PaneFocusButton run={run} />
          ) : (
            runCell(run, () => "—", t.inProgressPage.error)
          );
        },
      }),
      column.display({ id: "actions", header: t.columns.actions, cell: ActionsCell }),
    ],
    [names, latestRuns, t],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-semibold">{t.inProgressPage.title}</h1>
        <div className="flex w-64 flex-col gap-1">
          <Label htmlFor="in-progress-project">{t.columns.project}</Label>
          <Select
            id="in-progress-project"
            value={projectId}
            onChange={(e) => setFilters({ projectId: e.target.value })}
          >
            <option value="">{t.allProjects}</option>
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
          empty={t.inProgressPage.empty}
        />
      ) : (
        <Loading />
      )}
    </div>
  );
}
