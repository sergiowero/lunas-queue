// Claves y consultas de TanStack Query. Cualquier escritura invalida ["task", id] y las listas;
// el refresco periódico lo fija el QueryClient (ver main.tsx).
import { queryOptions } from "@tanstack/react-query";
import { api } from "./api.ts";

export const queries = {
  projects: () => queryOptions({ queryKey: ["projects"], queryFn: api.projects }),
  queue: (projectId?: string) =>
    queryOptions({ queryKey: ["queue", projectId ?? null], queryFn: () => api.queue(projectId) }),
  tasks: (projectId?: string) =>
    queryOptions({
      queryKey: ["tasks", projectId ?? null],
      queryFn: () => api.tasks(projectId),
    }),
  task: (id: string) => queryOptions({ queryKey: ["task", id], queryFn: () => api.task(id) }),
  dependencies: (id: string) =>
    queryOptions({ queryKey: ["task", id, "dependencies"], queryFn: () => api.dependencies(id) }),
  runs: (id: string) =>
    queryOptions({ queryKey: ["task", id, "runs"], queryFn: () => api.runs(id) }),
  events: (id: string) =>
    queryOptions({ queryKey: ["task", id, "events"], queryFn: () => api.events(id) }),
  usage: (id: string) =>
    queryOptions({ queryKey: ["task", id, "usage"], queryFn: () => api.usage(id) }),
  evidence: (id: string) =>
    queryOptions({ queryKey: ["task", id, "evidence"], queryFn: () => api.evidence(id) }),
  specs: (id: string) =>
    queryOptions({ queryKey: ["task", id, "specs"], queryFn: () => api.specs(id) }),
  specDiff: (id: string, version: number) =>
    queryOptions({
      queryKey: ["task", id, "specs", version, "diff"],
      queryFn: () => api.specDiff(id, version),
    }),
};
