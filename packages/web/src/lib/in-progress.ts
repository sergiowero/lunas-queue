// Regla de «tarea en curso» compartida por la pestaña En curso y el contador del menú.
import type { SubState, TaskState } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { queries } from "./queries.ts";

/** En curso: tarea en In progress o con un agente corriendo (sub-estado running), de cualquier fase. */
export function isInProgress(task: { state: TaskState; subState: SubState | null }): boolean {
  return task.state === "in_progress" || task.subState === "running";
}

/**
 * Cantidad de tareas en curso de todos los proyectos, sin importar el filtro de la página.
 * Comparte la clave ["tasks", null] con la bandeja, así que el stream en vivo la refresca solo.
 */
export function useInProgressCount(): number {
  const tasks = useQuery(queries.tasks());
  return tasks.data?.filter(isInProgress).length ?? 0;
}
