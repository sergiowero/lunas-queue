// A task's dependencies. In draft they are edited (the server only accepts them before refining,
// docs/design.md §State machine); afterwards the panel is read-only.
import type { DependencyLink, Task } from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, type Json } from "../../lib/api.ts";
import { useErrorText } from "../../lib/error-text.ts";
import { isTerminal, taskLabel } from "../../lib/format.ts";
import { useT } from "../../lib/i18n.ts";
import { queries } from "../../lib/queries.ts";
import { Muted, Section } from "../section.tsx";
import { QueryError } from "../status.tsx";
import { TaskNumber, taskLabel as taskNumberLabel } from "../task-number.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Label, Select } from "../ui/input.tsx";

function Links({
  title,
  links,
  onRemove,
}: {
  title: string;
  links: Json<DependencyLink>[];
  onRemove?: ((link: Json<DependencyLink>) => void) | undefined;
}) {
  const t = useT();
  if (links.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {links.map((link) => (
          <li key={link.taskId} className="flex flex-wrap items-center gap-2">
            <TaskNumber number={link.number} />
            <Link to="/tasks/$taskId" params={{ taskId: link.taskId }} className="hover:underline">
              {taskLabel(link)}
            </Link>
            <Badge variant="secondary">{t.state[link.state]}</Badge>
            {link.prState && <Badge variant="outline">PR {link.prState}</Badge>}
            {link.crossProject && (
              <Badge variant="destructive">{t.dependencies.otherProject}</Badge>
            )}
            {onRemove && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t.dependencies.removeAria(taskLabel(link))}
                onClick={() => onRemove(link)}
              >
                {t.dependencies.remove}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function useDependencyMutation(mutationFn: (dependsOnId: string) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      // It also changes the other task's panel (its dependents), hence all of ["task"].
      await Promise.all(
        ["task", "tasks", "queue"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
      );
    },
  });
}

function AddDependency({ task, taken }: { task: Json<Task>; taken: Set<string> }) {
  const t = useT();
  const errorText = useErrorText();
  const [selected, setSelected] = useState("");
  const projects = useQuery(queries.projects());
  const candidates = useQuery(queries.tasks());
  const add = useDependencyMutation((dependsOnId) => api.addDependency(task.id, dependsOnId));

  const live = (candidates.data ?? []).filter(
    (c) => c.id !== task.id && !taken.has(c.id) && !isTerminal(c.state),
  );
  const groups = [...(projects.data ?? [])]
    .sort((a, b) => Number(b.id === task.projectId) - Number(a.id === task.projectId))
    .map((project) => ({ project, tasks: live.filter((c) => c.projectId === project.id) }))
    .filter((group) => group.tasks.length > 0);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate(selected, { onSuccess: () => setSelected("") });
      }}
    >
      <Label htmlFor="add-dependency">{t.dependencies.add}</Label>
      {groups.length === 0 ? (
        <Muted>{t.dependencies.noCandidates}</Muted>
      ) : (
        <div className="flex gap-2">
          <Select
            id="add-dependency"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="" disabled>
              {t.dependencies.choose}
            </option>
            {groups.map(({ project, tasks }) => (
              <optgroup
                key={project.id}
                label={
                  project.id === task.projectId
                    ? project.name
                    : t.dependencies.otherProjectGroup(project.name)
                }
              >
                {tasks.map((c) => (
                  <option key={c.id} value={c.id}>
                    {`${taskNumberLabel(c.number)} · ${taskLabel(c)}`}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          <Button type="submit" size="sm" disabled={selected === "" || add.isPending}>
            {t.dependencies.addButton}
          </Button>
        </div>
      )}
      {add.error && (
        <p role="alert" className="text-sm text-destructive">
          {errorText(add.error)}
        </p>
      )}
    </form>
  );
}

export function DependenciesPanel({ task }: { task: Json<Task> }) {
  const t = useT();
  const errorText = useErrorText();
  const deps = useQuery(queries.dependencies(task.id));
  const remove = useDependencyMutation((dependsOnId) => api.removeDependency(task.id, dependsOnId));
  const editable = task.state === "draft";
  return (
    <Section title={t.dependencies.title}>
      {deps.error ? (
        <QueryError error={deps.error} />
      ) : deps.data ? (
        <div className="flex flex-col gap-3">
          {deps.data.dependsOn.length + deps.data.dependents.length === 0 ? (
            <Muted>{t.dependencies.none}</Muted>
          ) : (
            <>
              <Links
                title={t.dependencies.dependsOn}
                links={deps.data.dependsOn}
                onRemove={editable ? (link) => remove.mutate(link.taskId) : undefined}
              />
              <Links title={t.dependencies.dependents} links={deps.data.dependents} />
            </>
          )}
          {remove.error && (
            <p role="alert" className="text-sm text-destructive">
              {errorText(remove.error)}
            </p>
          )}
          {editable && (
            <AddDependency task={task} taken={new Set(deps.data.dependsOn.map((l) => l.taskId))} />
          )}
        </div>
      ) : null}
    </Section>
  );
}
