// Task creation: intent, tags, priority and initial dependencies (TaskCreate, ADR 0010). The
// validation is the server's; here only its issues are shown. Dependencies are added one by
// one with a selector and end up in a list of chosen ones, in the order they were added. They can be
// from any project; those from another are flagged as a risk, like in the detail.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Loading, QueryError } from "../components/status.tsx";
import { TaskNumber, taskLabel as taskNumberLabel } from "../components/task-number.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input, Label, Select, Textarea } from "../components/ui/input.tsx";
import { ApiError, api } from "../lib/api.ts";
import type { Dictionary } from "../lib/dictionary/index.ts";
import { errorText } from "../lib/error-text.ts";
import { isTerminal, taskLabel } from "../lib/format.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";

const route = getRouteApi("/tasks/new");

const DEFAULT_PRIORITY = 100;

function parseTags(text: string): string[] {
  return text
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

function describe(error: Error, t: Dictionary): string {
  if (error instanceof ApiError && error.issues.length > 0) {
    return error.issues.map((i) => `${i.path.join(".") || t.common.body}: ${i.message}`).join("; ");
  }
  return errorText(error, t);
}

export function NewTaskPage() {
  const t = useT();
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
  const live = (candidates.data ?? []).filter((c) => !isTerminal(c.state));
  // The chosen project first; then the others in the order of the project list.
  const groups = [...projects.data]
    .sort((a, b) => Number(b.id === projectId) - Number(a.id === projectId))
    .map((project) => ({
      project,
      tasks: live.filter((c) => c.projectId === project.id && !dependsOn.includes(c.id)),
    }))
    .filter((group) => group.tasks.length > 0);
  const projectName = new Map(projects.data.map((p) => [p.id, p.name]));
  const chosen = dependsOn.flatMap((id) => (candidates.data ?? []).filter((c) => c.id === id));

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold">{t.newTask.title}</h1>
      <div className="flex flex-col gap-1">
        <Label htmlFor="task-project">{t.newTask.project}</Label>
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
            {t.newTask.chooseProject}
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
          placeholder={t.newTask.intentPlaceholder}
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
          <Label htmlFor="task-priority">{t.newTask.priority}</Label>
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
          <Label htmlFor="task-depends-on">{t.newTask.dependsOn}</Label>
          {groups.length > 0 && (
            // Controlled with value="": choosing a task adds it and the selector goes back to the placeholder.
            <Select id="task-depends-on" value="" onChange={(e) => add(e.target.value)}>
              <option value="">{t.newTask.addDependency}</option>
              {groups.map(({ project, tasks }) => (
                <optgroup
                  key={project.id}
                  label={
                    project.id === projectId
                      ? project.name
                      : t.dependencies.otherProjectGroup(project.name)
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
            <ul aria-label={t.newTask.chosenDependencies} className="flex flex-col gap-1 text-sm">
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
                      {t.newTask.otherProject}
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t.newTask.removeAria(task.intent)}
                    onClick={() => remove(task.id)}
                  >
                    {t.newTask.remove}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {create.error && (
        <p role="alert" className="text-sm text-destructive">
          {t.newTask.createFailed(describe(create.error, t))}
        </p>
      )}
      <div>
        <Button type="submit" disabled={create.isPending || projectId === ""}>
          {t.newTask.create}
        </Button>
      </div>
    </form>
  );
}
