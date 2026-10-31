// Dependencias de una tarea. En draft se editan (el servidor solo las acepta antes de refinar,
// docs/design.md §Máquina de estados); después el panel es de solo lectura.
import type { DependencyLink, Task } from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, type Json } from "../../lib/api.ts";
import { isTerminal, STATE_LABEL } from "../../lib/format.ts";
import { queries } from "../../lib/queries.ts";
import { Muted, Section } from "../section.tsx";
import { QueryError } from "../status.tsx";
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
  if (links.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {links.map((link) => (
          <li key={link.taskId} className="flex flex-wrap items-center gap-2">
            <Link to="/tasks/$taskId" params={{ taskId: link.taskId }} className="hover:underline">
              {link.intent}
            </Link>
            <Badge variant="secondary">{STATE_LABEL[link.state]}</Badge>
            {link.prState && <Badge variant="outline">PR {link.prState}</Badge>}
            {link.crossProject && <Badge variant="destructive">otro proyecto</Badge>}
            {onRemove && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Quitar dependencia ${link.intent}`}
                onClick={() => onRemove(link)}
              >
                Quitar
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
      // Cambia también el panel de la otra tarea (sus dependientes), por eso todo ["task"].
      await Promise.all(
        ["task", "tasks", "queue", "graph"].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
}

function AddDependency({ task, taken }: { task: Json<Task>; taken: Set<string> }) {
  const [selected, setSelected] = useState("");
  const projects = useQuery(queries.projects());
  const candidates = useQuery(queries.tasks());
  const add = useDependencyMutation((dependsOnId) => api.addDependency(task.id, dependsOnId));

  const live = (candidates.data ?? []).filter(
    (t) => t.id !== task.id && !taken.has(t.id) && !isTerminal(t.state),
  );
  const groups = [...(projects.data ?? [])]
    .sort((a, b) => Number(b.id === task.projectId) - Number(a.id === task.projectId))
    .map((project) => ({ project, tasks: live.filter((t) => t.projectId === project.id) }))
    .filter((group) => group.tasks.length > 0);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate(selected, { onSuccess: () => setSelected("") });
      }}
    >
      <Label htmlFor="add-dependency">Agregar dependencia</Label>
      {groups.length === 0 ? (
        <Muted>No hay otras tareas activas de las que depender.</Muted>
      ) : (
        <div className="flex gap-2">
          <Select
            id="add-dependency"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="" disabled>
              Elige una tarea
            </option>
            {groups.map(({ project, tasks }) => (
              <optgroup
                key={project.id}
                label={
                  project.id === task.projectId ? project.name : `${project.name} · otro proyecto`
                }
              >
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.intent}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          <Button type="submit" size="sm" disabled={selected === "" || add.isPending}>
            Agregar
          </Button>
        </div>
      )}
      {add.error && (
        <p role="alert" className="text-sm text-destructive">
          {add.error.message}
        </p>
      )}
    </form>
  );
}

export function DependenciesPanel({ task }: { task: Json<Task> }) {
  const deps = useQuery(queries.dependencies(task.id));
  const remove = useDependencyMutation((dependsOnId) => api.removeDependency(task.id, dependsOnId));
  const editable = task.state === "draft";
  return (
    <Section title="Dependencias">
      {deps.error ? (
        <QueryError error={deps.error} />
      ) : deps.data ? (
        <div className="flex flex-col gap-3">
          {deps.data.dependsOn.length + deps.data.dependents.length === 0 ? (
            <Muted>Sin dependencias.</Muted>
          ) : (
            <>
              <Links
                title="Depende de"
                links={deps.data.dependsOn}
                onRemove={editable ? (link) => remove.mutate(link.taskId) : undefined}
              />
              <Links title="La esperan" links={deps.data.dependents} />
            </>
          )}
          {remove.error && (
            <p role="alert" className="text-sm text-destructive">
              {remove.error.message}
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
