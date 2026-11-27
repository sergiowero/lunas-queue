// Task detail (docs/design.md §Front end and §Audit): state, spec and versions, Runs,
// Event log, usage and evidence.
import type { Task } from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { CopyButton } from "../components/copy-button.tsx";
import { ProjectLabel } from "../components/project-label.tsx";
import { EmptyState, Loading, QueryError, StateBadges } from "../components/status.tsx";
import { DependenciesPanel } from "../components/task/dependencies.tsx";
import { EventLogPanel } from "../components/task/event-log.tsx";
import { EvidencePanel } from "../components/task/evidence.tsx";
import { GoalText } from "../components/task/goal-text.tsx";
import { InstructionsPanel } from "../components/task/instructions.tsx";
import { ResultPanel } from "../components/task/result.tsx";
import { RunsPanel } from "../components/task/runs.tsx";
import { SpecPanel } from "../components/task/spec.tsx";
import { UsagePanel } from "../components/task/usage.tsx";
import { PauseTaskButton, ResumeTaskButton } from "../components/task-actions.tsx";
import { TaskNumber } from "../components/task-number.tsx";
import { Time } from "../components/time.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { ApiError, api, type Json } from "../lib/api.ts";
import { useDocumentTitle } from "../lib/document-title.ts";
import { useErrorText } from "../lib/error-text.ts";
import { canPause, canResume, cappedTaskLabel, isTerminal, taskLabel } from "../lib/format.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";

const route = getRouteApi("/tasks/$taskId");

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-sm break-all">{children}</dd>
    </div>
  );
}

function CancelTask({ task }: { task: Json<Task> }) {
  const t = useT();
  const errorText = useErrorText();
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
      <Button
        variant="outline"
        size="sm"
        className="hover:border-danger/40 hover:bg-danger/[0.06] hover:text-danger-text"
        onClick={() => setConfirming(true)}
      >
        {t.taskDetail.cancel}
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap animate-fade-in items-center gap-2 rounded-lg border border-danger/25 bg-danger/[0.06] py-1 pr-1 pl-3 text-sm">
      <span className="font-medium">{t.taskDetail.confirmCancel}</span>
      <Button
        variant="destructive"
        size="sm"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate()}
      >
        {t.taskDetail.yesCancel}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        {t.taskDetail.no}
      </Button>
      {cancel.error && (
        <span role="alert" className="text-destructive">
          {errorText(cancel.error)}
        </span>
      )}
    </div>
  );
}

/** Why a queued task has no Run: its phase has no usable agent profile (docs/decisions/agent-profiles.md). */
function HoldNotice({ task }: { task: Json<Task> }) {
  const t = useT();
  const held = task.subState === "queued" && !isTerminal(task.state);
  const hold = useQuery({ ...queries.taskHold(task.id), enabled: held });
  if (!held || !hold.data?.hold) return null;
  const { reason, phase, projectId, projectName } = hold.data.hold;
  return (
    <div
      role="status"
      className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm"
    >
      <p>{t.taskDetail.hold[reason](projectName, t.phase[phase])}</p>
      {reason === "profile_missing" ? (
        <Link
          to="/projects"
          search={{ edit: projectId }}
          className="mt-1 inline-block font-medium underline underline-offset-2 hover:text-warning-text"
        >
          {t.taskDetail.hold.editProject}
        </Link>
      ) : (
        <Link
          to="/settings"
          className="mt-1 inline-block font-medium underline underline-offset-2 hover:text-warning-text"
        >
          {t.taskDetail.hold.enableInSettings}
        </Link>
      )}
    </div>
  );
}

/** The originating task by number and name; its id until the task list has loaded. */
function CausedByLink({ taskId }: { taskId: string }) {
  const tasks = useQuery(queries.tasks());
  const origin = tasks.data?.find((candidate) => candidate.id === taskId);
  return (
    <Link
      to="/tasks/$taskId"
      params={{ taskId }}
      className="text-primary-text underline underline-offset-2"
      title={origin ? taskLabel(origin) : undefined}
    >
      {origin ? (
        <>
          <TaskNumber number={origin.number} /> {cappedTaskLabel(origin)}
        </>
      ) : (
        taskId
      )}
    </Link>
  );
}

function Header({ task }: { task: Json<Task> }) {
  const t = useT();
  const projects = useQuery(queries.projects());
  const project = projects.data?.find((p) => p.id === task.projectId);
  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-baseline gap-2.5">
            <TaskNumber number={task.number} className="text-base" />
            <h1 className="text-2xl font-semibold tracking-tight whitespace-pre-wrap">
              {task.title ?? <GoalText goal={task.goal} />}
            </h1>
          </div>
          {task.title && (
            <p className="max-w-3xl text-sm text-muted-foreground whitespace-pre-wrap">
              <GoalText goal={task.goal} />
            </p>
          )}
        </div>
        {!isTerminal(task.state) && (
          <div className="flex flex-wrap items-center gap-2">
            {canPause(task.state) && <PauseTaskButton task={task} variant="text" />}
            {canResume(task.state) && <ResumeTaskButton task={task} variant="text" />}
            <CancelTask task={task} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StateBadges state={task.state} subState={task.subState} />
        {task.tags.map((tag) => (
          <Badge key={tag} variant="outline">
            #{tag}
          </Badge>
        ))}
        {task.riskLabel && <Badge variant="outline">{t.taskDetail.risk(task.riskLabel)}</Badge>}
      </div>
      <dl className="card grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-4">
        <Field label={t.taskDetail.project}>
          {project ? (
            <Link to="/projects/$projectId" params={{ projectId: project.id }} className="group">
              <ProjectLabel name={project.name} icon={project.icon} color={project.color} />
            </Link>
          ) : (
            "…"
          )}
        </Field>
        <Field label={t.taskDetail.priority}>{task.priority}</Field>
        <Field label={t.taskDetail.verificationIteration}>{task.verificationIteration}</Field>
        <Field label={t.taskDetail.created}>
          <Time iso={task.createdAt} />
        </Field>
        <Field label={t.taskDetail.branch}>
          {task.branch ? (
            <>
              <span className="font-mono text-[13px]">{task.branch}</span>
              <CopyButton value={task.branch} label={t.taskDetail.branch} />
            </>
          ) : (
            "—"
          )}
        </Field>
        <Field label={t.taskDetail.worktree}>
          {task.worktreePath ? (
            <>
              <span className="font-mono text-[13px]">{task.worktreePath}</span>
              <CopyButton value={task.worktreePath} label={t.taskDetail.worktree} />
            </>
          ) : (
            "—"
          )}
        </Field>
        <Field label={t.taskDetail.pr}>
          {task.prUrl ? (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary-text underline underline-offset-2 hover:decoration-2"
            >
              {task.prUrl}
            </a>
          ) : task.resultKind ? (
            t.taskDetail.noPr
          ) : (
            "—"
          )}
          {task.prState && ` (${task.prState})`}
          {task.prUrl && <CopyButton value={task.prUrl} label={t.taskDetail.pr} />}
        </Field>
        {task.causedBy && (
          <Field label={t.taskDetail.causedBy}>
            <CausedByLink taskId={task.causedBy} />
          </Field>
        )}
      </dl>
    </header>
  );
}

export function TaskDetailPage() {
  const t = useT();
  const { taskId } = route.useParams();
  const task = useQuery(queries.task(taskId));
  useDocumentTitle(task.data ? `#${task.data.number} · ${cappedTaskLabel(task.data)}` : null);
  if (task.error) {
    if (task.error instanceof ApiError && task.error.status === 404) {
      return <EmptyState>{t.taskDetail.notFound}</EmptyState>;
    }
    return <QueryError error={task.error} />;
  }
  if (!task.data) return <Loading />;
  return (
    <div className="flex flex-col gap-5">
      <Header task={task.data} />
      <HoldNotice task={task.data} />
      <ResultPanel task={task.data} />
      <InstructionsPanel taskId={taskId} instructions={task.data.instructions} />
      <div className="grid gap-4 lg:grid-cols-2">
        <DependenciesPanel task={task.data} />
        <UsagePanel key={taskId} taskId={taskId} />
      </div>
      <SpecPanel task={task.data} />
      <RunsPanel key={taskId} taskId={taskId} />
      <EventLogPanel taskId={taskId} />
      <EvidencePanel key={taskId} taskId={taskId} />
    </div>
  );
}
