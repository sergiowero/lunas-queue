// Open PR counter: completed tasks whose PR is still open, across all projects.
// It comes from the same tasks query that useLiveUpdates already invalidates.
import { useQuery } from "@tanstack/react-query";
import { queries } from "./queries.ts";

export function useOpenPrCount(): number {
  const tasks = useQuery(queries.tasks());
  return (tasks.data ?? []).filter((t) => t.state === "completed" && t.prState === "open").length;
}
