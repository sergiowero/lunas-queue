// Alta de tareas: intent, tags, prioridad y dependencias iniciales (TaskCreate, ADR 0010). La
// validación es la del servidor; aquí solo se muestran sus issues. Las dependencias pueden ser de
// cualquier proyecto; las de otro se marcan como riesgo, igual que en el detalle.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Muted } from "../components/section.tsx";
import { Loading, QueryError } from "../components/status.tsx";
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

  const toggle = (id: string, checked: boolean) =>
    setDependsOn((current) => (checked ? [...current, id] : current.filter((d) => d !== id)));

  if (projects.error) return <QueryError error={projects.error} />;
  if (!projects.data) return <Loading />;
  const live = (candidates.data ?? []).filter((t) => !isTerminal(t.state));
  // El proyecto elegido primero; después los demás en el orden del listado de proyectos.
  const groups = [...projects.data]
    .sort((a, b) => Number(b.id === projectId) - Number(a.id === projectId))
    .map((project) => ({ project, tasks: live.filter((t) => t.projectId === project.id) }))
    .filter((group) => group.tasks.length > 0);

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
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Depende de</legend>
        {projectId === "" ? (
          <Muted>Elige un proyecto para ver las tareas de las que depender.</Muted>
        ) : groups.length === 0 ? (
          <Muted>No hay tareas activas de las que depender.</Muted>
        ) : (
          groups.map(({ project, tasks }) => (
            <div key={project.id} className="flex flex-col gap-1">
              <h2 className="text-xs font-medium text-muted-foreground">
                {project.id === projectId ? project.name : `${project.name} · otro proyecto`}
              </h2>
              {tasks.map((task) => (
                <label key={task.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={dependsOn.includes(task.id)}
                    onChange={(e) => toggle(task.id, e.target.checked)}
                  />
                  {taskLabel(task)}
                </label>
              ))}
            </div>
          ))
        )}
      </fieldset>
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
