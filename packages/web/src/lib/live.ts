// Live updates (ADR uw-21-front-end): the server sends `change` over SSE with the tasks that
// had events and here their queries and the lists are invalidated, the inbox included. Blocks
// leave no events and refresh on their own (ADR uw-27-bandeja). EventSource reconnects on its own and sends
// Last-Event-ID; the QueryClient's periodic refresh stays as a safety net.
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export const CHANGE_STREAM_URL = "/api/stream";

export function invalidateChanges(
  queryClient: QueryClient,
  taskIds: string[],
  settings = false,
): void {
  // The configuration is global (settings.updated, agent_profile.*, project.updated): the Settings
  // page, the Profiles tab, the projects and the notices of other tabs refresh without waiting for the polling.
  if (settings) {
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    void queryClient.invalidateQueries({ queryKey: ["agent-profiles"] });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    // A held task's notice depends on the projects' profiles and on the enabled providers.
    void queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "task" && q.queryKey[2] === "hold",
    });
  }
  void queryClient.invalidateQueries({ queryKey: ["queue"] });
  void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  // Hook executions are task events. The hooks' content
  // (["project", id, "hooks"]) comes from git and is not invalidated by events.
  void queryClient.invalidateQueries({
    predicate: (q) => q.queryKey[0] === "project" && q.queryKey[2] === "hook-executions",
  });
  invalidateInbox(queryClient);
  for (const id of taskIds) void queryClient.invalidateQueries({ queryKey: ["task", id] });
}

/** Questions and blocks; the specs to approve come from ["tasks"]. */
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
        const { taskIds, settings } = JSON.parse(event.data) as {
          taskIds: string[];
          settings?: boolean;
        };
        invalidateChanges(queryClient, taskIds, settings === true);
      } catch {
        // An unreadable message does not break the UI: the periodic refresh covers it.
      }
    };
    source.addEventListener("change", onChange);
    return () => {
      source.removeEventListener("change", onChange);
      source.close();
    };
  }, [queryClient]);
}
