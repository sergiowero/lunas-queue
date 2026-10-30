// Cliente de la API de LunasQ. Los tipos vienen de @lunasq/schemas; por JSON las fechas llegan
// como string ISO, así que cada respuesta se tipa con Json<T>.
import type {
  BlockedAgent,
  EventView,
  HookExecutionView,
  Project,
  ProjectHooksView,
  Question,
  QuestionDelivery,
  QueueEntry,
  RunView,
  Spec,
  SpecContent,
  SpecDiff,
  Task,
  TaskCreate,
  TaskDependencies,
  TaskEvidence,
  TaskGraph,
  TaskUsage,
} from "@lunasq/schemas";

export type Json<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;

export type ApiIssue = { path: string[]; message: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ApiIssue[];

  constructor(status: number, code: string, message: string, issues: ApiIssue[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<Json<T>> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (res.status === 204) return undefined as Json<T>;
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : "http_error";
    const message = typeof body.message === "string" ? body.message : `${res.status} ${code}`;
    throw new ApiError(res.status, code, message, (body.issues as ApiIssue[] | undefined) ?? []);
  }
  return body as Json<T>;
}

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

const task = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

export type SpecResponse = { spec: Json<Spec>; task: Json<Task> };
export type AnswerResponse = { question: Json<Question>; delivery: QuestionDelivery };

export const api = {
  projects: () => request<Project[]>("/api/projects"),
  queue: (projectId?: string) =>
    request<QueueEntry[]>(
      projectId ? `/api/queue?projectId=${encodeURIComponent(projectId)}` : "/api/queue",
    ),
  tasks: (projectId?: string) =>
    request<Task[]>(
      projectId ? `/api/tasks?projectId=${encodeURIComponent(projectId)}` : "/api/tasks",
    ),
  graph: (projectId?: string) =>
    request<TaskGraph>(
      projectId ? `/api/graph?projectId=${encodeURIComponent(projectId)}` : "/api/graph",
    ),
  projectHooks: (projectId: string) =>
    request<ProjectHooksView>(`/api/projects/${encodeURIComponent(projectId)}/hooks`),
  hookExecutions: (projectId: string) =>
    request<HookExecutionView[]>(`/api/projects/${encodeURIComponent(projectId)}/hooks/executions`),
  task: (id: string) => request<Task>(task(id)),
  dependencies: (id: string) => request<TaskDependencies>(`${task(id)}/dependencies`),
  runs: (id: string) => request<RunView[]>(`${task(id)}/runs`),
  events: (id: string) => request<EventView[]>(`${task(id)}/events`),
  usage: (id: string) => request<TaskUsage>(`${task(id)}/usage`),
  /** null mientras la tarea no tiene archivo de evidencia. */
  evidence: async (id: string): Promise<Json<TaskEvidence> | null> => {
    try {
      return await request<TaskEvidence>(`${task(id)}/evidence`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "evidence_not_found") return null;
      throw error;
    }
  },
  specs: (id: string) => request<Spec[]>(`${task(id)}/specs`),
  specDiff: (id: string, version: number) => request<SpecDiff>(`${task(id)}/specs/${version}/diff`),
  createTask: (input: TaskCreate) => post<Task>("/api/tasks", input),
  cancelTask: (id: string) => post<Task>(`${task(id)}/cancel`),
  approveSpec: (id: string, version: number) =>
    post<SpecResponse>(`${task(id)}/specs/${version}/approve`),
  requestChanges: (id: string, version: number, comments: string) =>
    post<SpecResponse>(`${task(id)}/specs/${version}/request-changes`, { comments }),
  editAndApprove: (id: string, version: number, content: SpecContent) =>
    post<SpecResponse>(`${task(id)}/specs/${version}/edit-and-approve`, { content }),
  openQuestions: () => request<Question[]>("/api/questions?status=open"),
  answerQuestion: (id: string, answer: string) =>
    post<AnswerResponse>(`/api/questions/${encodeURIComponent(id)}/answer`, { answer }),
  blocked: () => request<BlockedAgent[]>("/api/blocked"),
  focusBlocked: (runId: string) => post<void>(`/api/blocked/${encodeURIComponent(runId)}/focus`),
};
