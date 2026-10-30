// Actualización en vivo (ADR uw-21-front-end): el servidor manda `change` por SSE con las tareas que
// tuvieron eventos y aquí se invalidan sus consultas y las listas, incluida la bandeja. El stream de
// notificaciones (ADR 0009) también la invalida: un `agent_blocked` llega sin evento en el log
// (ADR uw-27-bandeja). EventSource reconecta solo y manda Last-Event-ID; el refresco periódico del
// QueryClient queda como red de seguridad.
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export const CHANGE_STREAM_URL = "/api/stream";
export const NOTIFICATION_STREAM_URL = "/api/notifications/stream";

export function invalidateChanges(queryClient: QueryClient, taskIds: string[]): void {
  void queryClient.invalidateQueries({ queryKey: ["queue"] });
  void queryClient.invalidateQueries({ queryKey: ["tasks"] });
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
    const notifications = new EventSource(NOTIFICATION_STREAM_URL);
    const onNotification = () => invalidateInbox(queryClient);
    notifications.addEventListener("notification", onNotification);
    return () => {
      source.removeEventListener("change", onChange);
      source.close();
      notifications.removeEventListener("notification", onNotification);
      notifications.close();
    };
  }, [queryClient]);
}
