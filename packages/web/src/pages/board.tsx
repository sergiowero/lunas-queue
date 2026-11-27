// Per-project board (docs/design.md §Front end): one column per state of the machine.
import type { Task, TaskState } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { PlusIcon } from "../components/icons.tsx";
import { ProjectLabel } from "../components/project-label.tsx";
import { EmptyState, Loading, QueryError } from "../components/status.tsx";
import { TaskNumber } from "../components/task-number.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { buttonVariants } from "../components/ui/button.tsx";
import type { Json } from "../lib/api.ts";
import { BOARD_STATES, taskLabel } from "../lib/format.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";

const route = getRouteApi("/projects/$projectId");

function TaskCard({ task }: { task: Json<Task> }) {
  const t = useT();
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-sm shadow-xs transition-[border-color,box-shadow] duration-200 hover:border-border-strong hover:shadow-sm">
      <div className="flex items-baseline gap-2">
        <TaskNumber number={task.number} />
        <Link
          to="/tasks/$taskId"
          params={{ taskId: task.id }}
          className="font-medium transition-colors hover:text-primary-text hover:underline"
        >
          {taskLabel(task)}
        </Link>
      </div>
      <div className="flex flex-wrap gap-1">
        <Badge variant="outline">P{task.priority}</Badge>
        {task.subState && <Badge variant="secondary">{t.subState[task.subState]}</Badge>}
        {task.tags.map((tag) => (
          <Badge key={tag} variant="outline">
            #{tag}
          </Badge>
        ))}
      </div>
      {task.prUrl && (
        <a
          href={task.prUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary-text underline underline-offset-2"
        >
          PR {task.prState ?? ""}
        </a>
      )}
    </li>
  );
}

export function BoardPage() {
  const t = useT();
  const { projectId } = route.useParams();
  const projects = useQuery(queries.projects());
  const tasks = useQuery(queries.tasks(projectId));
  const project = projects.data?.find((p) => p.id === projectId);

  const error = projects.error ?? tasks.error;
  if (error) return <QueryError error={error} />;
  if (!projects.data || !tasks.data) return <Loading />;
  if (!project) return <EmptyState>{t.board.notFound}</EmptyState>;

  const byState = new Map<TaskState, Json<Task>[]>(BOARD_STATES.map((s) => [s, []]));
  for (const task of tasks.data) byState.get(task.state)?.push(task);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            <ProjectLabel name={project.name} icon={project.icon} color={project.color} />
          </h1>
          <p className="font-mono text-[13px] text-muted-foreground">{project.repo}</p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/projects/$projectId/hooks"
            params={{ projectId }}
            className={buttonVariants({ size: "sm", variant: "outline" })}
            aria-label={t.board.hooksAria}
          >
            {t.board.hooks}
          </Link>
          <Link
            to="/tasks/new"
            search={{ projectId }}
            className={buttonVariants({ size: "sm" })}
            aria-label={t.board.newTaskAria}
          >
            <PlusIcon />
            {t.board.newTask}
          </Link>
        </div>
      </div>
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6">
        {BOARD_STATES.map((state) => {
          const items = byState.get(state) ?? [];
          const headingId = `column-${state}`;
          return (
            <section
              key={state}
              aria-labelledby={headingId}
              className="flex min-h-40 w-72 shrink-0 flex-col gap-2 rounded-xl border border-border-light bg-surface-secondary/70 p-2"
            >
              <div className="flex items-center gap-2 px-1.5 pt-1 pb-0.5">
                <h2 id={headingId} className="text-[13px] font-semibold">
                  {t.state[state]}
                </h2>
                <span
                  aria-hidden="true"
                  className="text-xs font-medium text-text-muted tabular-nums"
                >
                  {items.length}
                </span>
              </div>
              {items.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                  {t.board.noTasks}
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {items.map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
