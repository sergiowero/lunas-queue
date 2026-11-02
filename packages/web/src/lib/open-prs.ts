// Contador de PR abiertos: tareas completadas cuyo PR sigue abierto, de todos los proyectos.
// Sale de la misma query de tareas que ya invalida useLiveUpdates.
import { useQuery } from "@tanstack/react-query";
import { queries } from "./queries.ts";

export function useOpenPrCount(): number {
  const tasks = useQuery(queries.tasks());
  return (tasks.data ?? []).filter((t) => t.state === "completed" && t.prState === "open").length;
}
