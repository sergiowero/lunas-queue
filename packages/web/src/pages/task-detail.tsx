// Detalle de tarea (docs/design.md §Front end y §Auditoría): estado, spec y versiones, Runs,
// Event log, usage y evidencia.
import type { Task } from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Loading, QueryError, StateBadges } from "../components/status.tsx";
import { DependenciesPanel } from "../components/task/dependencies.tsx";
import { EventLogPanel } from "../components/task/event-log.tsx";
import { EvidencePanel } from "../components/task/evidence.tsx";
import { RunsPanel } from "../components/task/runs.tsx";
import { SpecPanel } from "../components/task/spec.tsx";
import { UsagePanel } from "../components/task/usage.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { ApiError, api, type Json } from "../lib/api.ts";
import { formatDate, isTerminal } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";

const route = getRouteApi("/tasks/$taskId");

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-all">{children}</dd>
    </div>
  );
}

function CancelTask({ task }: { task: Json<Task> }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    mutationFn: () => api.cancelTask(task.id),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: ["task", task.id] });
      await queryClient.invalidateQueries({ queryKey: ["queue"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  if (!confirming) {
    return (
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
        Cancelar tarea
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <span>¿Cancelar la tarea?</span>
      <Button
        variant="destructive"
        size="sm"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate()}
      >
        Sí, cancelar
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        No
      </Button>
      {cancel.error && (
        <span role="alert" className="text-destructive">
          {cancel.error.message}
        </span>
      )}
    </div>
  );
}

function Header({ task }: { task: Json<Task> }) {
  const projects = useQuery(queries.projects());
  const project = projects.data?.find((p) => p.id === task.projectId);
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="text-xl font-semibold whitespace-pre-wrap">{task.intent}</h1>
        {!isTerminal(task.state) && <CancelTask task={task} />}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StateBadges state={task.state} subState={task.subState} />
        {task.tags.map((tag) => (
          <Badge key={tag} variant="outline">
            #{tag}
          </Badge>
        ))}
        {task.riskLabel && <Badge variant="outline">riesgo {task.riskLabel}</Badge>}
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Proyecto">
          {project ? (
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="hover:underline"
            >
              {project.name}
            </Link>
          ) : (
            "…"
          )}
        </Field>
        <Field label="Prioridad">{task.priority}</Field>
        <Field label="Iteración de verificación">{task.verificationIteration}</Field>
        <Field label="Creada">{formatDate(task.createdAt)}</Field>
        <Field label="Branch">{task.branch ?? "—"}</Field>
        <Field label="Worktree">{task.worktreePath ?? "—"}</Field>
        <Field label="PR">
          {task.prUrl ? (
            <a href={task.prUrl} target="_blank" rel="noreferrer" className="underline">
              {task.prUrl}
            </a>
          ) : (
            "—"
          )}
          {task.prState && ` (${task.prState})`}
        </Field>
        {task.causedBy && (
          <Field label="Originada por">
            <Link to="/tasks/$taskId" params={{ taskId: task.causedBy }} className="underline">
              {task.causedBy}
            </Link>
          </Field>
        )}
      </dl>
    </header>
  );
}

export function TaskDetailPage() {
  const { taskId } = route.useParams();
  const task = useQuery(queries.task(taskId));
  if (task.error) {
    if (task.error instanceof ApiError && task.error.status === 404) {
      return <p className="text-sm">La tarea no existe.</p>;
    }
    return <QueryError error={task.error} />;
  }
  if (!task.data) return <Loading />;
  return (
    <div className="flex flex-col gap-4">
      <Header task={task.data} />
      <div className="grid gap-4 lg:grid-cols-2">
        <DependenciesPanel taskId={taskId} />
        <UsagePanel taskId={taskId} />
      </div>
      <SpecPanel task={task.data} />
      <RunsPanel taskId={taskId} />
      <EventLogPanel taskId={taskId} />
      <EvidencePanel key={taskId} taskId={taskId} />
    </div>
  );
}
