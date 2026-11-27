// Global queue (docs/design.md §Front end): the ready set in the scheduler order and then the
// other live tasks. The score and the usage are computed by the server.

import type { QueueEntry } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type CellContext, createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { AgentBadge } from "../components/agent-badge.tsx";
import { DataTable } from "../components/data-table.tsx";
import { EmptyWithNewTask } from "../components/empty-state.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { ProjectLabel } from "../components/project-label.tsx";
import { Loading, QueryError, StateBadges, stateText } from "../components/status.tsx";
import { PauseTaskButton, ResumeTaskButton } from "../components/task-actions.tsx";
import { TaskNumber } from "../components/task-number.tsx";
import { Label, Select } from "../components/ui/input.tsx";
import type { Json } from "../lib/api.ts";
import { pendingPhase } from "../lib/attribution.ts";
import { useDocumentTitle } from "../lib/document-title.ts";
import {
  canPause,
  canResume,
  cappedTaskLabel,
  formatCost,
  formatTokens,
  fullLabelTitle,
} from "../lib/format.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";
import { useProjectFilter, useTabFilters } from "../lib/tab-filters.tsx";

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
  useDocumentTitle(t.queue.title);
  const [, setFilters] = useTabFilters("queue");
  const projects = useQuery(queries.projects());
  const projectId = useProjectFilter("queue", projects.data);
  const queue = useQuery(queries.queue(projectId || undefined));
  const byId = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);

  const columns = useMemo(
    () => [
      column.display({
        id: "position",
        header: "#",
        cell: (c) => <span className="text-text-muted">{c.row.index + 1}</span>,
      }),
      column.accessor((e) => cappedTaskLabel(e.task), {
        id: "goal",
        header: t.columns.task,
        cell: (c) => (
          <span className="flex min-w-48 items-baseline gap-2">
            <TaskNumber number={c.row.original.task.number} />
            <Link
              to="/tasks/$taskId"
              params={{ taskId: c.row.original.task.id }}
              className="font-medium transition-colors hover:text-primary-text hover:underline"
              title={fullLabelTitle(c.row.original.task)}
            >
              {c.getValue()}
            </Link>
          </span>
        ),
      }),
      // The accessor stays the project's name: it is what the column sorts and filters by.
      column.accessor((e) => byId.get(e.task.projectId)?.name ?? "…", {
        id: "project",
        header: t.columns.project,
        cell: (c) => {
          const project = byId.get(c.row.original.task.projectId);
          return project ? (
            <ProjectLabel name={project.name} icon={project.icon} color={project.color} />
          ) : (
            c.getValue()
          );
        },
      }),
      column.accessor((e) => stateText(e.task, t), {
        id: "state",
        header: t.columns.state,
        cell: (c) => (
          <StateBadges state={c.row.original.task.state} subState={c.row.original.task.subState} />
        ),
      }),
      // The agent that will take the task's next phase: the profile its project assigns to it.
      column.display({
        id: "agent",
        header: t.queue.agent,
        cell: (c) => {
          const { task } = c.row.original;
          const phase = pendingPhase(task.state);
          const project = byId.get(task.projectId);
          if (!phase) return "—";
          if (!project) return "…";
          return <AgentBadge profileId={project.agentProfiles[phase]} />;
        },
      }),
      column.accessor(priority, { id: "priority", header: t.columns.priority }),
      column.accessor(score, { id: "score", header: t.queue.score }),
      // Display column: token and cost formats follow the language (see runs.tsx).
      column.display({
        id: "usage",
        header: t.queue.usage,
        cell: (c) => (
          <span className="whitespace-nowrap text-text-secondary">
            {`${formatTokens(c.row.original.usage)} · ${formatCost(c.row.original.usage.costUsd)}`}
          </span>
        ),
      }),
      column.display({ id: "actions", header: t.columns.actions, cell: ActionsCell }),
    ],
    [byId, t],
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t.queue.title}>
        <div className="flex w-64 flex-col gap-1.5">
          <Label htmlFor="queue-project">{t.columns.project}</Label>
          <Select
            id="queue-project"
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
      </PageHeader>
      {queue.error ? (
        <QueryError error={queue.error} />
      ) : queue.data ? (
        <DataTable
          columns={columns}
          data={queue.data}
          getRowId={(e) => e.task.id}
          empty={<EmptyWithNewTask message={t.queue.empty} {...(projectId ? { projectId } : {})} />}
        />
      ) : (
        <Loading />
      )}
    </div>
  );
}
