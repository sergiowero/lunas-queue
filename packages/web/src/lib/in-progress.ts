// «Task in progress» rule shared by the In progress tab and the menu counter.
import type { SubState, TaskState } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { queries } from "./queries.ts";

/** In progress: a task in In progress or with a running agent (running sub-state), of any phase. */
export function isInProgress(task: { state: TaskState; subState: SubState | null }): boolean {
  return task.state === "in_progress" || task.subState === "running";
}

/**
 * Number of tasks in progress across all projects, regardless of the page's filter.
 * Shares the ["tasks", null] key with the inbox, so the live stream refreshes it on its own.
 */
export function useInProgressCount(): number {
  const tasks = useQuery(queries.tasks());
  return tasks.data?.filter(isInProgress).length ?? 0;
}
