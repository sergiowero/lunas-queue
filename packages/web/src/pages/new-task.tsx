// Alta de tareas: intent, tags, prioridad y dependencias iniciales (TaskCreate, ADR 0010). La
// validación es la del servidor; aquí solo se muestran sus issues. Las dependencias se agregan una a
// una con un selector y quedan en una lista de elegidas, en el orden en que se agregaron. Pueden ser
// de cualquier proyecto; las de otro se marcan como riesgo, igual que en el detalle.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Loading, QueryError } from "../components/status.tsx";
import { TaskNumber, taskLabel as taskNumberLabel } from "../components/task-number.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input, Label, Select, Textarea } from "../components/ui/input.tsx";
import { ApiError, api } from "../lib/api.ts";
import { isTerminal, taskLabel } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";

const route = getRouteApi("/tasks/new");

const DEFAULT_PRIORITY = 100;

function parseTags(text: string): string[] {
  return text
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

function describe(error: Error): string {
  if (error instanceof ApiError && error.issues.length > 0) {
    return error.issues.map((i) => `${i.path.join(".") || "(cuerpo)"}: ${i.message}`).join("; ");
  }
  return error.message;
}

export function NewTaskPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState(search.projectId ?? "");
  const [intent, setIntent] = useState("");
  const [tags, setTags] = useState("");
  const [priority, setPriority] = useState(String(DEFAULT_PRIORITY));
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const projects = useQuery(queries.projects());
  const candidates = useQuery({ ...queries.tasks(), enabled: projectId !== "" });

  const create = useMutation({
    mutationFn: api.createTask,
    onSuccess: async (task) => {
      await queryClient.invalidateQueries({ queryKey: ["queue"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await navigate({ to: "/tasks/$taskId", params: { taskId: task.id } });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({
      projectId,
      intent,
      tags: parseTags(tags),
      priority: Number(priority),
      dependsOn,
    });
  };

  const add = (id: string) =>
    setDependsOn((current) => (id === "" || current.includes(id) ? current : [...current, id]));
  const remove = (id: string) => setDependsOn((current) => current.filter((d) => d !== id));

  if (projects.error) return <QueryError error={projects.error} />;
  if (!projects.data) return <Loading />;
  const live = (candidates.data ?? []).filter((t) => !isTerminal(t.state));
  // El proyecto elegido primero; después los demás en el orden del listado de proyectos.
  const groups = [...projects.data]
    .sort((a, b) => Number(b.id === projectId) - Number(a.id === projectId))
    .map((project) => ({
      project,
      tasks: live.filter((t) => t.projectId === project.id && !dependsOn.includes(t.id)),
    }))
    .filter((group) => group.tasks.length > 0);
  const projectName = new Map(projects.data.map((p) => [p.id, p.name]));
  const chosen = dependsOn.flatMap((id) => (candidates.data ?? []).filter((t) => t.id === id));

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Nueva tarea</h1>
      <div className="flex flex-col gap-1">
        <Label htmlFor="task-project">Proyecto</Label>
        <Select
          id="task-project"
          required
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setDependsOn([]);
          }}
        >
          <option value="" disabled>
            Elige un proyecto
          </option>
          {projects.data.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="task-intent">Intent</Label>
        <Textarea
          id="task-intent"
          required
          rows={5}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          placeholder="Qué debe lograr la tarea y por qué"
        />
      </div>
      <div className="flex gap-4">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="task-tags">Tags</Label>
          <Input
            id="task-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="auth, ui"
          />
        </div>
        <div className="flex w-40 flex-col gap-1">
          <Label htmlFor="task-priority">Prioridad</Label>
          <Input
            id="task-priority"
            type="number"
            min={0}
            step={1}
            required
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </div>
      </div>
      {(groups.length > 0 || chosen.length > 0) && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="task-depends-on">Depende de</Label>
          {groups.length > 0 && (
            // Controlado con value="": al elegir una tarea se agrega y el selector vuelve al placeholder.
            <Select id="task-depends-on" value="" onChange={(e) => add(e.target.value)}>
              <option value="">Agregar una dependencia…</option>
              {groups.map(({ project, tasks }) => (
                <optgroup
                  key={project.id}
                  label={
                    project.id === projectId ? project.name : `${project.name} · otro proyecto`
                  }
                >
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {`${taskNumberLabel(task.number)} · ${taskLabel(task)}`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          )}
          {chosen.length > 0 && (
            <ul aria-label="Dependencias elegidas" className="flex flex-col gap-1 text-sm">
              {chosen.map((task) => (
                <li
                  key={task.id}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5"
                >
                  <TaskNumber number={task.number} />
                  <span data-intent className="flex-1">
                    {taskLabel(task)}
                  </span>
                  {task.projectId !== projectId && (
                    <Badge variant="destructive" title={projectName.get(task.projectId)}>
                      otro proyecto
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Quitar ${task.intent}`}
                    onClick={() => remove(task.id)}
                  >
                    Quitar
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {create.error && (
        <p role="alert" className="text-sm text-destructive">
          No se pudo crear la tarea: {describe(create.error)}
        </p>
      )}
      <div>
        <Button type="submit" disabled={create.isPending || projectId === ""}>
          Crear tarea
        </Button>
      </div>
    </form>
  );
}
