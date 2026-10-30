// Lo que espera al humano (ADR uw-27-bandeja): specs por aprobar (tareas en refined), preguntas
// abiertas y agentes bloqueados. La bandeja lo muestra y el menú cuenta el total.
import type { Task } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Json } from "./api.ts";
import { queries } from "./queries.ts";

export type TasksById = Map<string, Json<Task>>;

/** Lo que espera al humano; el menú muestra el total. */
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
  const byId: TasksById = useMemo(
    () => new Map((tasks.data ?? []).map((t) => [t.id, t])),
    [tasks.data],
  );
  const count = refined.length + (questions.data?.length ?? 0) + (blocked.data?.length ?? 0);
  return { tasks, questions, blocked, refined, byId, count };
}

export type Inbox = ReturnType<typeof useInbox>;
