// What waits for the human (ADR uw-27-bandeja): specs to approve (tasks in refined), escalated
// tasks (needs_human), open questions and blocked agents. The inbox shows it and the
// menu counts the total.
import type { Task } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Json } from "./api.ts";
import { queries } from "./queries.ts";

export type TasksById = Map<string, Json<Task>>;

/** What waits for the human; the menu shows the total. */
export function useInbox() {
  const tasks = useQuery(queries.tasks());
  const questions = useQuery(queries.openQuestions());
  const blocked = useQuery(queries.blocked());
  const refined = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t) => t.state === "refined")
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    [tasks.data],
  );
  const escalated = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t) => t.state === "needs_human")
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    [tasks.data],
  );
  const byId: TasksById = useMemo(
    () => new Map((tasks.data ?? []).map((t) => [t.id, t])),
    [tasks.data],
  );
  const count =
    refined.length + escalated.length + (questions.data?.length ?? 0) + (blocked.data?.length ?? 0);
  return { tasks, questions, blocked, refined, escalated, byId, count };
}

export type Inbox = ReturnType<typeof useInbox>;
