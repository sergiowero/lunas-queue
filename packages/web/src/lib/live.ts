// Actualización en vivo (ADR uw-21-front-end): el servidor manda `change` por SSE con las tareas que
// tuvieron eventos y aquí se invalidan sus consultas y las listas, incluida la bandeja. Los bloqueos
// no dejan eventos y se refrescan solos (ADR uw-27-bandeja). EventSource reconecta solo y manda
// Last-Event-ID; el refresco periódico del QueryClient queda como red de seguridad.
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export const CHANGE_STREAM_URL = "/api/stream";

export function invalidateChanges(queryClient: QueryClient, taskIds: string[]): void {
  void queryClient.invalidateQueries({ queryKey: ["queue"] });
  void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  // Las ejecuciones de hooks son eventos de tarea. El contenido de los hooks
  // (["project", id, "hooks"]) viene de git y no se invalida por eventos.
  void queryClient.invalidateQueries({
    predicate: (q) => q.queryKey[0] === "project" && q.queryKey[2] === "hook-executions",
  });
  invalidateInbox(queryClient);
  for (const id of taskIds) void queryClient.invalidateQueries({ queryKey: ["task", id] });
}

/** Preguntas y bloqueos; las specs por aprobar salen de ["tasks"]. */
export function invalidateInbox(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["questions"] });
  void queryClient.invalidateQueries({ queryKey: ["blocked"] });
}

export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(CHANGE_STREAM_URL);
    const onChange = (event: MessageEvent<string>) => {
      try {
        const { taskIds } = JSON.parse(event.data) as { taskIds: string[] };
        invalidateChanges(queryClient, taskIds);
      } catch {
        // Un mensaje ilegible no rompe la UI: el refresco periódico lo cubre.
      }
    };
    source.addEventListener("change", onChange);
    return () => {
      source.removeEventListener("change", onChange);
      source.close();
    };
  }, [queryClient]);
}
