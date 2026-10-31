// Tablero por proyecto (docs/design.md §Front end): una columna por estado de la máquina.
import type { Task, TaskState } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Loading, QueryError } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { buttonVariants } from "../components/ui/button.tsx";
import type { Json } from "../lib/api.ts";
import { BOARD_STATES, STATE_LABEL, SUB_STATE_LABEL, taskLabel } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";

const route = getRouteApi("/projects/$projectId");

function TaskCard({ task }: { task: Json<Task> }) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-background p-3 text-sm shadow-sm">
      <Link
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        className="font-medium hover:underline"
      >
        {taskLabel(task)}
      </Link>
      <div className="flex flex-wrap gap-1">
        <Badge variant="outline">P{task.priority}</Badge>
        {task.subState && <Badge variant="secondary">{SUB_STATE_LABEL[task.subState]}</Badge>}
        {task.tags.map((tag) => (
          <Badge key={tag} variant="outline">
            #{tag}
          </Badge>
        ))}
      </div>
      {task.prUrl && (
        <a href={task.prUrl} target="_blank" rel="noreferrer" className="text-xs underline">
          PR {task.prState ?? ""}
        </a>
      )}
    </li>
  );
}

export function BoardPage() {
  const { projectId } = route.useParams();
  const projects = useQuery(queries.projects());
  const tasks = useQuery(queries.tasks(projectId));
  const project = projects.data?.find((p) => p.id === projectId);

  const error = projects.error ?? tasks.error;
  if (error) return <QueryError error={error} />;
  if (!projects.data || !tasks.data) return <Loading />;
  if (!project) return <p className="text-sm">El proyecto no existe.</p>;

  const byState = new Map<TaskState, Json<Task>[]>(BOARD_STATES.map((s) => [s, []]));
  for (const task of tasks.data) byState.get(task.state)?.push(task);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{project.name}</h1>
          <p className="text-sm text-muted-foreground">{project.repo}</p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/dag"
            search={{ projectId }}
            className={buttonVariants({ size: "sm", variant: "outline" })}
            aria-label="DAG de este proyecto"
          >
            DAG
          </Link>
          <Link
            to="/projects/$projectId/hooks"
            params={{ projectId }}
            className={buttonVariants({ size: "sm", variant: "outline" })}
            aria-label="Hooks de este proyecto"
          >
            Hooks
          </Link>
          <Link
            to="/tasks/new"
            search={{ projectId }}
            className={buttonVariants({ size: "sm" })}
            aria-label="Nueva tarea en este proyecto"
          >
            Nueva tarea
          </Link>
        </div>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {BOARD_STATES.map((state) => {
          const items = byState.get(state) ?? [];
          const headingId = `column-${state}`;
          return (
            <section
              key={state}
              aria-labelledby={headingId}
              className="flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-muted p-2"
            >
              <h2 id={headingId} className="px-1 text-sm font-semibold">
                {STATE_LABEL[state]}
              </h2>
              {items.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">Sin tareas</p>
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
