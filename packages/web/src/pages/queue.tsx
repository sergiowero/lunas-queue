// Global queue (docs/design.md §Front end): the ready set in the scheduler order and then the
// other live tasks. The score and the usage are computed by the server.
import type { QueueEntry } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type CellContext, createColumnHelper } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { DataTable } from "../components/data-table.tsx";
import { Loading, QueryError, StateBadges, stateText } from "../components/status.tsx";
import { PauseTaskButton, ResumeTaskButton } from "../components/task-actions.tsx";
import { TaskNumber } from "../components/task-number.tsx";
import { Label, Select } from "../components/ui/input.tsx";
import type { Json } from "../lib/api.ts";
import { canPause, canResume, formatCost, formatTokens, taskLabel } from "../lib/format.ts";
import { useT } from "../lib/i18n.ts";
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

/** Icons only, with the task in the aria-label: pause if it can be paused, resume if it is paused or escalated. */
function ActionsCell({ row }: CellContext<Entry, unknown>) {
  const { task } = row.original;
  if (canPause(task.state)) return <PauseTaskButton task={task} variant="icon" />;
  if (canResume(task.state)) return <ResumeTaskButton task={task} variant="icon" />;
  return null;
}

export function QueuePage() {
  const t = useT();
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
        header: t.columns.task,
        cell: (c) => (
          <span className="flex items-baseline gap-2">
            <TaskNumber number={c.row.original.task.number} />
            <Link
              to="/tasks/$taskId"
              params={{ taskId: c.row.original.task.id }}
              className="font-medium hover:underline"
            >
              {c.getValue()}
            </Link>
          </span>
        ),
      }),
      column.accessor((e) => names.get(e.task.projectId) ?? "…", {
        id: "project",
        header: t.columns.project,
      }),
      column.accessor((e) => stateText(e.task, t), {
        id: "state",
        header: t.columns.state,
        cell: (c) => (
          <StateBadges state={c.row.original.task.state} subState={c.row.original.task.subState} />
        ),
      }),
      column.accessor(priority, { id: "priority", header: t.columns.priority }),
      column.accessor(score, { id: "score", header: t.queue.score }),
      // Display column: token and cost formats follow the language (see runs.tsx).
      column.display({
        id: "usage",
        header: t.queue.usage,
        cell: (c) =>
          `${formatTokens(c.row.original.usage)} · ${formatCost(c.row.original.usage.costUsd)}`,
      }),
      column.display({ id: "actions", header: t.columns.actions, cell: ActionsCell }),
    ],
    [names, t],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-semibold">{t.queue.title}</h1>
        <div className="flex w-64 flex-col gap-1">
          <Label htmlFor="queue-project">{t.columns.project}</Label>
          <Select
            id="queue-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
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
      {queue.error ? (
        <QueryError error={queue.error} />
      ) : queue.data ? (
        <DataTable
          columns={columns}
          data={queue.data}
          getRowId={(e) => e.task.id}
          empty={t.queue.empty}
        />
      ) : (
        <Loading />
      )}
    </div>
  );
}
