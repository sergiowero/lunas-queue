// Botones de pausar y reanudar una tarea, compartidos por el detalle, En curso y Cola. La variante
// `text` lleva icono y texto; `icon` solo el icono, con el nombre de la tarea en el aria-label.
import type { Task } from "@lunasq/schemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Json } from "../lib/api.ts";
import { taskLabel } from "../lib/format.ts";
import { PauseIcon, ResumeIcon } from "./icons.tsx";
import { MutationError } from "./status.tsx";
import { Button } from "./ui/button.tsx";

type ActionTask = Pick<Json<Task>, "id" | "title" | "intent">;
type Variant = "text" | "icon";

/** Mueve la tarea: refresca su detalle, la Cola y las listas. */
function useTaskTransition(taskId: string, mutationFn: () => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
        queryClient.invalidateQueries({ queryKey: ["queue"] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      ]);
    },
  });
}

function ActionButton(props: {
  task: ActionTask;
  variant: Variant;
  label: string;
  icon: React.ReactNode;
  action: () => Promise<unknown>;
  primary?: boolean;
}) {
  const { task, variant, label, icon, action, primary } = props;
  const mutation = useTaskTransition(task.id, action);
  const iconOnly = variant === "icon";
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant={primary ? "default" : "outline"}
        size="sm"
        aria-label={iconOnly ? `${label} ${taskLabel(task)}` : label}
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {icon}
        {!iconOnly && label}
      </Button>
      {mutation.error && <MutationError error={mutation.error} />}
    </div>
  );
}

export function PauseTaskButton({ task, variant }: { task: ActionTask; variant: Variant }) {
  return (
    <ActionButton
      task={task}
      variant={variant}
      label="Pausar tarea"
      icon={<PauseIcon />}
      action={() => api.pauseTask(task.id)}
    />
  );
}

export function ResumeTaskButton({ task, variant }: { task: ActionTask; variant: Variant }) {
  return (
    <ActionButton
      task={task}
      variant={variant}
      label="Reanudar tarea"
      icon={<ResumeIcon />}
      action={() => api.resumeTask(task.id)}
      primary
    />
  );
}
