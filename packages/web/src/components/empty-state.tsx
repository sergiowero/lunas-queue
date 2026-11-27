// An empty list's sentence plus the obvious next step: create a task (in the filtered project, if any).
import { Link } from "@tanstack/react-router";
import { useT } from "../lib/i18n.ts";

export function EmptyWithNewTask({ message, projectId }: { message: string; projectId?: string }) {
  const t = useT();
  return (
    <span className="inline-flex flex-wrap items-baseline justify-center gap-x-2">
      <span>{message}</span>
      <Link
        to="/tasks/new"
        search={projectId ? { projectId } : {}}
        className="font-medium text-primary-text underline"
      >
        {t.common.createTask}
      </Link>
    </span>
  );
}
