// Buttons to pause and resume a task, shared by the detail, In progress and Queue. The `text`
// variant carries icon and text; `icon` only the icon, with the task's name in the aria-label.
import type { Task } from "@lunasq/schemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Json } from "../lib/api.ts";
import { taskLabel } from "../lib/format.ts";
import { useT } from "../lib/i18n.ts";
import { PauseIcon, ResumeIcon } from "./icons.tsx";
import { MutationError } from "./status.tsx";
import { Button } from "./ui/button.tsx";

type ActionTask = Pick<Json<Task>, "id" | "title" | "goal">;
type Variant = "text" | "icon";

/** Moves the task: refreshes its detail, the Queue and the lists. */
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
  const t = useT();
  return (
    <ActionButton
      task={task}
      variant={variant}
      label={t.taskActions.pause}
      icon={<PauseIcon />}
      action={() => api.pauseTask(task.id)}
    />
  );
}

export function ResumeTaskButton({ task, variant }: { task: ActionTask; variant: Variant }) {
  const t = useT();
  return (
    <ActionButton
      task={task}
      variant={variant}
      label={t.taskActions.resume}
      icon={<ResumeIcon />}
      action={() => api.resumeTask(task.id)}
      primary
    />
  );
}
