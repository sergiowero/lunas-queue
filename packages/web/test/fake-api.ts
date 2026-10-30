// API de LunasQ en memoria para los tests del front end. Responde las mismas rutas y formas que
// packages/server (tipadas con Json<T> de @lunasq/schemas) y deja simular lo que hacen el
// scheduler y los agentes: transiciones, Runs, specs, usage, evidencia, preguntas y bloqueos. Valida
// y rechaza como el servidor (TaskCreate, 422 de referencias, 409 del gate y de la máquina de
// estados, 409 de preguntas ya respondidas).

import type {
  Actor,
  BlockedAgent,
  EventView,
  EvidenceSource,
  Phase,
  Project,
  Question,
  QueueEntry,
  RunView,
  Spec,
  SpecContent,
  SubState,
  Task,
  TaskState,
  TaskUsage,
  UsageTotals,
} from "@lunasq/schemas";
import {
  QuestionAnswer,
  SpecEditAndApprove,
  SpecRequestChanges,
  TaskCreate,
} from "@lunasq/schemas";
import type { Json } from "../src/lib/api.ts";

const EMPTY: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
};

export const SPEC_CONTENT: SpecContent = {
  domainModel: {
    boundedContext: "Autenticación",
    glossary: [{ term: "Sesión", definition: "Login vigente" }],
    aggregates: [{ name: "Usuario", entities: ["Sesión"] }],
    invariants: [],
    events: [],
  },
  requirements: ["El usuario inicia sesión con email"],
  criteria: [{ id: "AC-1", given: "un usuario", when: "inicia sesión", outcome: "entra" }],
  taskList: [{ id: "T-1", title: "Formulario de login", criterionIds: ["AC-1"] }],
};

type Request = { method: string; path: string; body: unknown };

const conflict = (error: string, message: string): [number, unknown] => [409, { error, message }];

/** Valida como el servidor (`invalidInput`): 400 con los issues del esquema, o los datos. */
function validate<T>(
  schema: {
    safeParse: (
      body: unknown,
    ) =>
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
  },
  body: unknown,
): { ok: true; data: T } | { ok: false; response: [number, unknown] } {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message }));
  return { ok: false, response: [400, { error: "invalid_input", issues }] };
}

let seq = 0;
const uuid = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

export class FakeApi {
  readonly projects: Json<Project>[] = [];
  readonly tasks: Json<Task>[] = [];
  readonly edges: { taskId: string; dependsOnId: string }[] = [];
  readonly runs: Json<RunView>[] = [];
  readonly events: Json<EventView>[] = [];
  readonly specs: Json<Spec>[] = [];
  readonly usage = new Map<string, Json<TaskUsage>>();
  readonly evidence = new Map<string, string>();
  /** Origen de la evidencia por tarea; sin entrada, el worktree. */
  readonly evidenceSource = new Map<string, EvidenceSource>();
  readonly requests: Request[] = [];
  readonly questions: Json<Question>[] = [];
  /** Lo que respondería el RunWatcher: los agentes bloqueados ahora. */
  blocked: Json<BlockedAgent>[] = [];
  /** Nombres de agente que la UI pidió enfocar en herdr. */
  readonly focused: string[] = [];
  /** Si se fija, `POST /api/blocked/:runId/focus` responde este error de herdr. */
  focusError: { status: number; error: string; message: string } | null = null;
  /** Si el agente que preguntó sigue vivo: la respuesta va al pane; si no, a un Run nuevo. */
  agentAlive = false;
  /** Si se fija, GET /api/queue responde esto tal cual. */
  queue: Json<QueueEntry>[] | null = null;
  private clock = Date.parse("2026-10-29T10:00:00Z");
  private eventId = 0;

  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  addProject(overrides: Partial<Json<Project>> = {}): Json<Project> {
    const at = this.now();
    const project: Json<Project> = {
      id: uuid(),
      name: `proyecto-${seq}`,
      repo: "sergiowero/demo",
      baseBranch: "main",
      localPath: `/repos/demo-${seq}`,
      agentProfiles: {
        refine: { kind: "claude", args: [] },
        implement: { kind: "claude", args: [] },
        verify: { kind: "claude", args: [] },
      },
      limits: {},
      testCommand: null,
      bootstrap: null,
      createdAt: at,
      updatedAt: at,
      ...overrides,
    } as Json<Project>;
    this.projects.push(project);
    return project;
  }

  addTask(projectId: string, overrides: Partial<Json<Task>> = {}): Json<Task> {
    const at = this.now();
    const task: Json<Task> = {
      id: uuid(),
      projectId,
      intent: "Hacer algo",
      tags: [],
      priority: 100,
      state: "draft",
      subState: "queued",
      verificationIteration: 0,
      branch: null,
      worktreePath: null,
      prUrl: null,
      prState: null,
      riskLabel: null,
      causedBy: null,
      createdAt: at,
      updatedAt: at,
      ...overrides,
    };
    this.tasks.push(task);
    this.event(task.id, "task.created", "human", { intent: task.intent });
    return task;
  }

  event(taskId: string, type: string, actor: Actor, payload: unknown = null): void {
    this.eventId += 1;
    this.events.push({ id: this.eventId, taskId, type, actor, payload, createdAt: this.now() });
  }

  /** Como la máquina de estados: mueve la tarea y deja task.transitioned en el Event log. */
  transition(
    taskId: string,
    state: TaskState,
    subState: SubState | null,
    patch: Partial<Json<Task>> = {},
  ): void {
    const task = this.task(taskId);
    const from = { state: task.state, subState: task.subState };
    Object.assign(task, { state, subState, updatedAt: this.now(), ...patch });
    this.event(taskId, "task.transitioned", "system", {
      command: "test",
      from,
      to: { state, subState },
      verificationIteration: task.verificationIteration,
    });
  }

  startRun(taskId: string, phase: Phase): Json<RunView> {
    const run: Json<RunView> = {
      id: uuid(),
      taskId,
      phase,
      agentKind: "claude",
      model: "opus",
      iteration: this.task(taskId).verificationIteration,
      herdrWorkspace: "w1",
      herdrPane: `p-${seq}`,
      herdrName: `lunasq-${phase}`,
      agentSession: null,
      agentSessionSource: null,
      startedAt: this.now(),
      endedAt: null,
      result: null,
      failureReason: null,
      handoff: null,
    };
    this.runs.push(run);
    return run;
  }

  endRun(runId: string, patch: Partial<Json<RunView>>): void {
    const run = this.runs.find((r) => r.id === runId);
    if (!run) throw new Error(`run ${runId} no existe`);
    Object.assign(run, { endedAt: this.now(), result: "success", ...patch });
  }

  addSpec(taskId: string, content: SpecContent = SPEC_CONTENT): Json<Spec> {
    const version = this.specs.filter((s) => s.taskId === taskId).length + 1;
    const spec: Json<Spec> = {
      id: uuid(),
      taskId,
      version,
      content,
      approval: "pending",
      createdBy: "agent",
      approvedBy: null,
      approvedAt: null,
      reviewComments: null,
      createdAt: this.now(),
    };
    this.specs.push(spec);
    this.event(taskId, "spec.version_created", "agent", { specId: spec.id, version });
    return spec;
  }

  /** Como `ask_human`: guarda la Question y pasa la tarea a waiting_human. */
  ask(taskId: string, question: string, context: string | null = null): Json<Question> {
    const task = this.task(taskId);
    const run = this.runs.findLast((r) => r.taskId === taskId);
    const created: Json<Question> = {
      id: uuid(),
      taskId,
      runId: run?.id ?? null,
      question,
      context,
      status: "open",
      answer: null,
      answeredBy: null,
      answeredAt: null,
      createdAt: this.now(),
    };
    this.questions.push(created);
    this.event(taskId, "question.created", "agent", { questionId: created.id });
    this.transition(taskId, task.state, "waiting_human");
    return created;
  }

  /** Como el RunWatcher cuando herdr reporta `blocked`. */
  block(run: Json<RunView>): Json<BlockedAgent> {
    const agent: Json<BlockedAgent> = {
      runId: run.id,
      taskId: run.taskId,
      phase: run.phase as BlockedAgent["phase"],
      agentName: run.herdrName ?? "agente",
      paneId: run.herdrPane ?? "p-?",
      since: this.now(),
    };
    this.blocked.push(agent);
    return agent;
  }

  task(id: string): Json<Task> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`tarea ${id} no existe`);
    return task;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://lunasq.test");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    this.requests.push({ method, path: url.pathname + url.search, body });
    const [status, payload] = this.route(method, url, body);
    return new Response(status === 204 ? null : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  private route(method: string, url: URL, body: unknown): [number, unknown] {
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const [resource, id, sub, version, action] = parts;
    const notFound: [number, unknown] = [404, { error: "not_found" }];

    if (resource === "projects" && method === "GET") return [200, this.projects];
    if (resource === "questions") return this.question(method, url, id, sub, body);
    if (resource === "blocked") {
      if (method === "GET") return [200, this.blocked];
      const agent = this.blocked.find((b) => b.runId === id);
      if (sub !== "focus" || !agent) {
        return [404, { error: "not_blocked", message: "el Run no tiene un agente bloqueado" }];
      }
      if (this.focusError) {
        const { status, ...error } = this.focusError;
        return [status, error];
      }
      this.focused.push(agent.agentName);
      return [204, null];
    }
    if (resource === "queue") return [200, this.queue ?? this.defaultQueue(url)];
    if (resource !== "tasks") return notFound;

    if (!id) {
      if (method === "POST") return this.create(body);
      const projectId = url.searchParams.get("projectId");
      return [200, this.tasks.filter((t) => !projectId || t.projectId === projectId)];
    }
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return notFound;
    switch (sub) {
      case undefined:
        return [200, task];
      case "cancel":
        if (task.state === "completed" || task.state === "cancelled") {
          return conflict("invalid_transition", `la tarea ya está en ${task.state}`);
        }
        this.transition(id, "cancelled", null);
        return [200, task];
      case "dependencies":
        return [
          200,
          { dependsOn: this.links(id, "dependsOn"), dependents: this.links(id, "dependents") },
        ];
      case "runs":
        return [200, this.runs.filter((r) => r.taskId === id)];
      case "events":
        return [200, this.events.filter((e) => e.taskId === id)];
      case "usage":
        return [200, this.usage.get(id) ?? { total: EMPTY, byRun: [] }];
      case "evidence": {
        const markdown = this.evidence.get(id);
        if (markdown === undefined) return [404, { error: "evidence_not_found" }];
        const source = this.evidenceSource.get(id) ?? "worktree";
        const file = `lunasq/tasks/${id}.md`;
        const path =
          source === "worktree" ? `${task.worktreePath}/${file}` : `origin/${task.branch}:${file}`;
        return [200, { source, path, markdown }];
      }
      case "specs":
        return this.spec(task, method, Number(version), action, body);
      default:
        return notFound;
    }
  }

  private question(
    method: string,
    url: URL,
    id: string | undefined,
    sub: string | undefined,
    body: unknown,
  ): [number, unknown] {
    if (!id) {
      const status = url.searchParams.get("status");
      return [200, this.questions.filter((q) => !status || q.status === status)];
    }
    const question = this.questions.find((q) => q.id === id);
    if (method === "GET") return question ? [200, question] : [404, { error: "not_found" }];
    if (sub !== "answer") return [404, { error: "not_found" }];
    // Como el servidor: primero el cuerpo, después la pregunta.
    const input = validate(QuestionAnswer, body);
    if (!input.ok) return input.response;
    if (!question) return [404, { error: "not_found" }];
    const answer = input.data.answer;
    if (question.status !== "open") {
      return conflict("not_open", `la pregunta ya está en ${question.status}`);
    }
    const task = this.task(question.taskId);
    if (task.subState !== "waiting_human") {
      return conflict("task_not_waiting", "la tarea ya no espera una respuesta");
    }
    const delivery = this.agentAlive ? "pane" : "new_run";
    Object.assign(question, {
      status: "answered",
      answer: answer.trim(),
      answeredBy: "human",
      answeredAt: this.now(),
    });
    this.event(task.id, "question.answered", "human", { questionId: id, delivery });
    this.transition(task.id, task.state, delivery === "pane" ? "running" : "queued");
    return [200, { question, delivery }];
  }

  private create(body: unknown): [number, unknown] {
    const parsed = TaskCreate.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({
        path: i.path.map(String),
        message: i.message,
      }));
      return [400, { error: "invalid_input", issues }];
    }
    const input = parsed.data;
    if (!this.projects.some((p) => p.id === input.projectId)) {
      return [422, { error: "project_not_found", message: "no existe el proyecto" }];
    }
    if (input.dependsOn.some((id) => !this.tasks.some((t) => t.id === id))) {
      return [422, { error: "dependency_not_found", message: "no existe la dependencia" }];
    }
    const task = this.addTask(input.projectId, {
      intent: input.intent,
      tags: input.tags,
      priority: input.priority,
    });
    for (const dependsOnId of input.dependsOn) this.edges.push({ taskId: task.id, dependsOnId });
    return [201, task];
  }

  private spec(
    task: Json<Task>,
    method: string,
    version: number,
    action: string | undefined,
    body: unknown,
  ): [number, unknown] {
    const versions = this.specs.filter((s) => s.taskId === task.id);
    if (Number.isNaN(version)) return [200, versions];
    // Como el servidor: en un POST se valida el cuerpo antes de buscar la versión.
    const input =
      method !== "POST"
        ? null
        : action === "edit-and-approve"
          ? validate(SpecEditAndApprove, body)
          : action === "request-changes"
            ? validate(SpecRequestChanges, body)
            : null;
    if (input && !input.ok) return input.response;
    const spec = versions.find((s) => s.version === version);
    if (!spec) return [404, { error: "not_found" }];
    if (method === "GET" && action === "diff") {
      const previous = versions.find((s) => s.version === version - 1);
      const added = previous ? [] : spec.content.criteria;
      return [
        200,
        {
          from: previous?.version ?? null,
          to: version,
          identical: false,
          changes: {
            domainModel: {
              boundedContext: null,
              glossary: { added: [], removed: [], changed: [] },
              aggregates: { added: [], removed: [], changed: [] },
              invariants: { added: [], removed: [] },
              events: { added: [], removed: [], changed: [] },
            },
            requirements: {
              added: previous ? [] : spec.content.requirements,
              removed: [],
            },
            criteria: { added, removed: [], changed: [] },
            taskList: { added: previous ? [] : spec.content.taskList, removed: [], changed: [] },
          },
        },
      ];
    }
    if (method === "GET") return [200, spec];
    const latest = versions.at(-1)?.version;
    if (version !== latest) {
      return conflict("stale_version", `la versión ${version} fue superada por la ${latest}`);
    }
    if (spec.approval !== "pending") {
      return conflict("spec_not_pending", `la versión ${version} ya está en ${spec.approval}`);
    }
    if (task.state !== "refined") {
      return conflict("invalid_transition", `la tarea está en ${task.state}, no en refined`);
    }
    if (action === "approve") {
      Object.assign(spec, { approval: "approved", approvedBy: "human", approvedAt: this.now() });
      this.event(task.id, "spec.approved", "human", { specId: spec.id, version });
      this.transition(task.id, "in_progress", "queued");
      return [200, { spec, task }];
    }
    if (action === "edit-and-approve") {
      const { content } = (input?.ok ? input.data : body) as { content: SpecContent };
      const edited = this.addSpec(task.id, content);
      Object.assign(edited, {
        createdBy: "human",
        approval: "approved",
        approvedBy: "human",
        approvedAt: this.now(),
      });
      this.event(task.id, "spec.approved", "human", { specId: edited.id, version: edited.version });
      this.transition(task.id, "in_progress", "queued");
      return [200, { spec: edited, task }];
    }
    if (action === "request-changes") {
      const { comments } = (input?.ok ? input.data : body) as { comments: string };
      Object.assign(spec, { approval: "changes_requested", reviewComments: comments });
      this.event(task.id, "spec.changes_requested", "human", { version, comments });
      this.transition(task.id, "draft", "queued");
      return [200, { spec, task }];
    }
    return [404, { error: "not_found" }];
  }

  private links(id: string, side: "dependsOn" | "dependents") {
    const ids = this.edges
      .filter((e) => (side === "dependsOn" ? e.taskId === id : e.dependsOnId === id))
      .map((e) => (side === "dependsOn" ? e.dependsOnId : e.taskId));
    const self = this.task(id);
    return ids.map((otherId) => {
      const other = this.task(otherId);
      return {
        taskId: other.id,
        projectId: other.projectId,
        intent: other.intent,
        state: other.state,
        prState: other.prState,
        crossProject: other.projectId !== self.projectId,
        createdAt: other.createdAt,
      };
    });
  }

  /** Cola simple: vivas, el ready set (queued en fase con agente) primero por prioridad. */
  private defaultQueue(url: URL): Json<QueueEntry>[] {
    const projectId = url.searchParams.get("projectId");
    const live = this.tasks.filter(
      (t) =>
        (!projectId || t.projectId === projectId) &&
        t.state !== "completed" &&
        t.state !== "cancelled",
    );
    const isReady = (t: Json<Task>) =>
      ["draft", "in_progress", "verification"].includes(t.state) && t.subState === "queued";
    const entry = (t: Json<Task>): Json<QueueEntry> => {
      const usage = this.usage.get(t.id)?.total ?? EMPTY;
      return isReady(t)
        ? { task: t, ready: true, score: t.priority, effectivePriority: t.priority, usage }
        : { task: t, ready: false, score: null, effectivePriority: null, usage };
    };
    return [
      ...live.filter(isReady).sort((a, b) => b.priority - a.priority),
      ...live.filter((t) => !isReady(t)),
    ].map(entry);
  }
}
