// Actualización en vivo (ADR uw-21-front-end): el servidor manda `change` por SSE con las tareas que
// tuvieron eventos y aquí se invalidan sus consultas y las listas. EventSource reconecta solo y
// manda Last-Event-ID; el refresco periódico del QueryClient queda como red de seguridad.
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export const CHANGE_STREAM_URL = "/api/stream";

export function invalidateChanges(queryClient: QueryClient, taskIds: string[]): void {
  void queryClient.invalidateQueries({ queryKey: ["queue"] });
  void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  for (const id of taskIds) void queryClient.invalidateQueries({ queryKey: ["task", id] });
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
