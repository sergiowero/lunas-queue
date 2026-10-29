// Lógica de las tools del LunasQ MCP, sin transporte (docs/design.md §MCPs y skills, ADR
// uw-15-mcp-tools). Cada llamada pasa por el mismo orden de guardas: run token de un Run activo,
// tool permitida en la fase del Run y get_task_context ya leído. Las tools de salida escriben el
// handoff, el cierre del Run y la transición de la tarea en una sola transacción IMMEDIATE.
import {
  appendChecklist,
  applyTransition,
  closeRun,
  consecutiveFailures,
  createQuestion,
  type LunasqDatabase,
  latestChecklist,
  listQuestions,
  ProjectRepository,
  RunRepository,
  type RunRow,
  SpecRepository,
  TaskRepository,
  type TransitionTaskInput,
  type Tx,
} from "@lunasq/db";
import {
  type AskHumanInput,
  type ChecklistItem,
  type Handoff,
  type HandoffError,
  type HandoffPhase,
  type Phase,
  parseHandoff,
  type ReportFailureInput,
  type Spec,
  type TaskContext,
  type UpdateChecklistInput,
} from "@lunasq/schemas";
import type { CommitVerifier, TestGate } from "./ports.ts";

export const TOOL_NAMES = [
  "get_task_context",
  "submit_spec",
  "ask_human",
  "update_checklist",
  "submit_for_verification",
  "submit_verdict",
  "report_failure",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const ALL_PHASES: readonly Phase[] = ["refine", "implement", "verify", "deliver"];

/** Fases del Run en las que cada tool se acepta. */
export const TOOL_PHASES: Readonly<Record<ToolName, readonly Phase[]>> = {
  get_task_context: ALL_PHASES,
  ask_human: ALL_PHASES,
  report_failure: ALL_PHASES,
  submit_spec: ["refine"],
  update_checklist: ["implement"],
  submit_for_verification: ["implement"],
  submit_verdict: ["verify"],
};

export type McpErrorCode =
  // Sin run token, desconocido o de un Run ya cerrado.
  | "invalid_run_token"
  | "tool_not_allowed"
  | "context_required"
  | "invalid_handoff"
  // Handoff con taskId, runId o fase que no son los del Run.
  | "handoff_mismatch"
  | "no_approved_spec"
  // Criterios o tareas del handoff que no coinciden con la spec aprobada.
  | "spec_mismatch"
  | "commits_missing"
  | "dirty_worktree"
  // Ya corre un gate de tests para este Run.
  | "gate_in_progress"
  | "test_gate_failed"
  | "verdict_already_recorded"
  | "no_worktree"
  // La máquina de estados rechazó la transición (estado de la tarea, guard o actor).
  | "transition_rejected";

export type McpError = {
  code: McpErrorCode;
  message: string;
  issues?: HandoffError[];
  output?: string;
};

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: McpError };

const fail = (code: McpErrorCode, message: string, extra: Partial<McpError> = {}) =>
  ({ ok: false, error: { code, message, ...extra } }) as const;

const AFTER_VERDICT: readonly ToolName[] = ["get_task_context", "submit_verdict"];

const HANDOFF_PHASE: Readonly<Record<Phase, HandoffPhase | null>> = {
  refine: "refinement",
  implement: "implementation",
  verify: "verification",
  deliver: null,
};

// Revierte la transacción de una escritura rechazada y lleva el rechazo a quien llama.
class Rejected extends Error {
  readonly failure: { ok: false; error: McpError };

  constructor(failure: { ok: false; error: McpError }) {
    super(failure.error.message);
    this.failure = failure;
  }
}

export interface McpServiceDeps {
  db: LunasqDatabase;
  testGate: TestGate;
  commitVerifier: CommitVerifier;
}

export class LunasqMcpService {
  readonly #db: LunasqDatabase;
  readonly #runs: RunRepository;
  readonly #specs: SpecRepository;
  readonly #projects: ProjectRepository;
  readonly #tasks: TaskRepository;
  readonly #testGate: TestGate;
  readonly #commits: CommitVerifier;
  // Runs con un gate de tests en curso: un reintento no lanza una segunda suite en paralelo.
  readonly #gating = new Set<string>();

  constructor(deps: McpServiceDeps) {
    this.#db = deps.db;
    this.#runs = new RunRepository(deps.db);
    this.#specs = new SpecRepository(deps.db);
    this.#projects = new ProjectRepository(deps.db);
    this.#tasks = new TaskRepository(deps.db);
    this.#testGate = deps.testGate;
    this.#commits = deps.commitVerifier;
  }

  /** Guardas comunes: Run activo, tool de su fase y contexto leído (salvo get_task_context). */
  authorize(token: string | undefined, tool: ToolName): Outcome<RunRow> {
    const run = token ? this.#runs.activeByToken(token) : null;
    if (!run) {
      return fail(
        "invalid_run_token",
        "run token ausente, desconocido o de un Run cerrado: esta sesión ya no puede mover la tarea",
      );
    }
    if (!TOOL_PHASES[tool].includes(run.phase)) {
      return fail("tool_not_allowed", `${tool} no se acepta en la fase ${run.phase}`);
    }
    if (tool !== "get_task_context" && !run.contextReadAt) {
      return fail("context_required", `llama get_task_context antes de ${tool}`);
    }
    // Tras un pass el Run sigue abierto solo para la entrega: el verificador ya no mueve la tarea.
    if (run.phase === "verify" && run.handoff !== null && !AFTER_VERDICT.includes(tool)) {
      return fail("tool_not_allowed", `el Run ya registró su veredicto; ${tool} no se acepta`);
    }
    return { ok: true, data: run };
  }

  getTaskContext(run: RunRow): Outcome<TaskContext> {
    const { task, project } = this.#taskAndProject(run);
    this.#runs.markContextRead(run.id);

    const approved = this.#specs.approved(task.id);
    const latest = run.phase === "refine" ? this.#specs.list(task.id)?.at(-1) : undefined;
    const previous = this.#runs.previousRun(task.id, run.phase, run.id);
    const context: TaskContext = {
      task: {
        id: task.id,
        intent: task.intent,
        tags: task.tags,
        state: task.state,
        subState: task.subState,
        verificationIteration: task.verificationIteration,
        branch: task.branch,
        worktreePath: task.worktreePath,
      },
      run: { id: run.id, phase: run.phase, iteration: run.iteration },
      project: {
        name: project.name,
        repo: project.repo,
        baseBranch: project.baseBranch,
        testCommand: project.testCommand ?? null,
      },
      approvedSpec: approved ? { version: approved.version, content: approved.content } : null,
      changesRequested:
        latest?.approval === "changes_requested"
          ? {
              version: latest.version,
              content: latest.content,
              comments: latest.reviewComments ?? "",
            }
          : null,
      implementation:
        this.#storedHandoffs(task.id, "implement").filter(isImplementation).at(-1) ?? null,
      verificationHistory: this.#storedHandoffs(task.id, "verify").filter(isVerification),
      previousAttempt: previous
        ? {
            runId: previous.id,
            failureReason: previous.failureReason,
            handoff: previous.handoff ? (storedHandoff(previous.handoff) ?? null) : null,
          }
        : null,
      questions: listQuestions(this.#db, task.id).map((q) => ({
        id: q.id,
        question: q.question,
        context: q.context,
        status: q.status,
        answer: q.answer,
      })),
      checklist: latestChecklist(this.#db, task.id),
    };
    return { ok: true, data: context };
  }

  submitSpec(run: RunRow, input: unknown): Outcome<{ specVersion: number }> {
    const parsed = this.#parse(run, input, "refinement");
    if (!parsed.ok) return parsed;
    const { assumptions: _assumptions, ...content } = parsed.data.body;
    return this.#write((tx) => {
      this.#close(tx, run, { result: "success", handoff: parsed.data });
      const result = this.#specs.applySubmit(tx, run.taskId, content);
      if (!result.ok) throw new Rejected(fail("transition_rejected", result.error.message));
      return { ok: true, data: { specVersion: result.spec.version } };
    });
  }

  askHuman(run: RunRow, input: AskHumanInput): Outcome<{ questionId: string }> {
    return this.#write((tx) => {
      this.#transition(tx, { taskId: run.taskId, actor: "agent", command: { type: "ask_human" } });
      const question = createQuestion(tx, {
        taskId: run.taskId,
        runId: run.id,
        question: input.question,
        ...(input.context === undefined ? {} : { context: input.context }),
      });
      return { ok: true, data: { questionId: question.id } };
    });
  }

  updateChecklist(
    run: RunRow,
    input: UpdateChecklistInput,
  ): Outcome<{ checklist: ChecklistItem[] }> {
    const spec = this.#specs.approved(run.taskId);
    if (!spec) return fail("no_approved_spec", "la tarea no tiene spec aprobada");
    const known = new Set(spec.content.taskList.map((t) => t.id));
    const unknown = input.items.filter((i) => !known.has(i.taskId));
    if (unknown.length > 0) {
      return fail("spec_mismatch", "items que no están en la task list de la spec aprobada", {
        issues: unknown.map((i) => ({
          path: `items[${input.items.indexOf(i)}].taskId`,
          message: `la spec aprobada no tiene la tarea ${i.taskId}`,
        })),
      });
    }
    return this.#write((tx) => {
      const current = latestChecklist(tx, run.taskId);
      const done = new Map((current ?? []).map((i) => [i.taskId, i.done]));
      for (const item of input.items) done.set(item.taskId, item.done);
      const checklist = spec.content.taskList.map((t) => ({
        taskId: t.id,
        title: t.title,
        done: done.get(t.id) ?? false,
      }));
      // Repetir la misma marca no agrega otro evento.
      if (JSON.stringify(checklist) !== JSON.stringify(current)) {
        appendChecklist(tx, run.taskId, run.id, checklist);
      }
      return { ok: true, data: { checklist } };
    });
  }

  async submitForVerification(
    run: RunRow,
    input: unknown,
  ): Promise<Outcome<{ state: "verification" }>> {
    const parsed = this.#parse(run, input, "implementation");
    if (!parsed.ok) return parsed;
    const handoff = parsed.data;
    const spec = this.#specs.approved(run.taskId);
    if (!spec) return fail("no_approved_spec", "la tarea no tiene spec aprobada");
    const coverage = checkCriteria(
      spec,
      handoff.body.criterionTests.map((c) => c.criterionId),
      "body.criterionTests",
      "no tiene tests en criterionTests",
    );
    if (!coverage.ok) return coverage;

    const { task, project } = this.#taskAndProject(run);
    if (!task.worktreePath) return fail("no_worktree", "la tarea no tiene worktree registrado");

    if (this.#gating.has(run.id)) {
      return fail(
        "gate_in_progress",
        "ya corre un gate de tests para este Run; espera su resultado",
      );
    }
    this.#gating.add(run.id);
    try {
      const rejected = await this.#checkWorktree(run, handoff, task.worktreePath, project);
      if (rejected) return rejected;
    } finally {
      this.#gating.delete(run.id);
    }
    return this.#write((tx) => {
      this.#close(tx, run, { result: "success", handoff });
      this.#transition(tx, {
        taskId: run.taskId,
        actor: "agent",
        command: {
          type: "submit_for_verification",
          testGatePassed: true,
          everyCriterionHasTest: true,
          hasCommits: true,
        },
        // Los tests corrieron fuera de la transacción: la tarea no debe haberse movido.
        expected: { state: "in_progress", subState: "running" },
      });
      return { ok: true, data: { state: "verification" } };
    });
  }

  submitVerdict(run: RunRow, input: unknown): Outcome<{ verdict: "pass" | "reject" }> {
    const parsed = this.#parse(run, input, "verification");
    if (!parsed.ok) return parsed;
    const handoff = parsed.data;
    const spec = this.#specs.approved(run.taskId);
    if (!spec) return fail("no_approved_spec", "la tarea no tiene spec aprobada");
    const coverage = checkCriteria(
      spec,
      handoff.body.criteriaVerdicts.map((c) => c.criterionId),
      "body.criteriaVerdicts",
      "no tiene veredicto",
    );
    if (!coverage.ok) return coverage;

    return this.#write((tx) => {
      // Un Run registra un solo veredicto: repetir el mismo no cambia nada.
      const current = this.#runs.get(run.id);
      if (!current || current.endedAt) throw new Rejected(staleRun());
      if (current.handoff !== null) {
        if (JSON.stringify(current.handoff) === JSON.stringify(handoff)) {
          return { ok: true, data: { verdict: handoff.body.verdict } };
        }
        throw new Rejected(
          fail("verdict_already_recorded", "este Run ya registró un veredicto distinto"),
        );
      }
      if (handoff.body.verdict === "reject") {
        this.#close(tx, run, { result: "success", handoff });
        this.#transition(tx, {
          taskId: run.taskId,
          actor: "agent",
          command: { type: "verdict_rework" },
          expected: { state: "verification", subState: "running" },
        });
        return { ok: true, data: { verdict: "reject" } };
      }
      // Pass: el Run sigue abierto y la entrega (UW-26) emite verdict_pass tras crear el PR.
      const task = this.#tasks.get(run.taskId);
      if (task?.state !== "verification" || task.subState !== "running") {
        throw new Rejected(fail("transition_rejected", "la tarea no está en verification/running"));
      }
      this.#runs.recordHandoff(run.id, handoff);
      return { ok: true, data: { verdict: "pass" } };
    });
  }

  reportFailure(run: RunRow, input: ReportFailureInput): Outcome<{ attempt: number }> {
    return this.#write((tx) => {
      const attempt = consecutiveFailures(tx, run.taskId, run.phase) + 1;
      this.#close(tx, run, { result: "failure", failureReason: input.reason });
      // El agente declara el fallo; quien lo registra en la máquina de estados es el sistema.
      this.#transition(tx, {
        taskId: run.taskId,
        actor: "system",
        command: { type: "run_failed", attempt },
      });
      return { ok: true, data: { attempt } };
    });
  }

  #parse<P extends HandoffPhase>(
    run: RunRow,
    input: unknown,
    phase: P,
  ): Outcome<Extract<Handoff, { phase: P }>> {
    const parsed = parseHandoff(input);
    if (!parsed.success) {
      return fail("invalid_handoff", "el handoff no cumple el esquema", { issues: parsed.errors });
    }
    const handoff = parsed.data;
    const issues: HandoffError[] = [];
    if (handoff.phase !== phase || HANDOFF_PHASE[run.phase] !== phase) {
      issues.push({ path: "phase", message: `se esperaba ${phase} y llegó ${handoff.phase}` });
    }
    if (handoff.taskId !== run.taskId) {
      issues.push({ path: "taskId", message: `el Run es de la tarea ${run.taskId}` });
    }
    if (handoff.runId !== run.id) {
      issues.push({ path: "runId", message: `el Run activo es ${run.id}` });
    }
    if (issues.length > 0) {
      return fail("handoff_mismatch", "el handoff no corresponde a este Run", { issues });
    }
    return { ok: true, data: handoff as Extract<Handoff, { phase: P }> };
  }

  /** Commits del branch, worktree limpio y gate de tests en verde; null si todo pasa. */
  async #checkWorktree(
    run: RunRow,
    handoff: ImplementationHandoff,
    worktreePath: string,
    project: { baseBranch: string; testCommand?: string | null },
  ): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    const dirty = await this.#commits.uncommitted(worktreePath);
    if (dirty.length > 0) {
      return fail("dirty_worktree", "el worktree tiene cambios sin commitear", {
        issues: dirty.map((file) => ({ path: file, message: "cambio sin commitear" })),
      });
    }
    const missing = await this.#commits.missing({
      worktreePath,
      baseBranch: project.baseBranch,
      commits: handoff.body.commits,
    });
    if (missing.length > 0) {
      return fail("commits_missing", "commits que no están en el branch de la tarea", {
        issues: missing.map((sha) => ({
          path: `body.commits[${handoff.body.commits.indexOf(sha)}]`,
          message: `${sha} no está en el branch de la tarea o ya está en ${project.baseBranch}`,
        })),
      });
    }
    // El gate lo corre LunasQ sobre lo commiteado: lo que el agente diga de sus tests no cuenta.
    const gate = await this.#testGate.run({
      taskId: run.taskId,
      runId: run.id,
      worktreePath,
      command: project.testCommand ?? null,
    });
    if (!gate.passed) {
      return fail("test_gate_failed", "el gate de tests está en rojo", { output: gate.output });
    }
    return null;
  }

  #taskAndProject(run: RunRow) {
    const task = this.#tasks.get(run.taskId);
    const project = task ? this.#projects.get(task.projectId) : null;
    if (!task || !project) {
      throw new Error(`el Run ${run.id} apunta a una tarea o proyecto inexistente`);
    }
    return { task, project };
  }

  #storedHandoffs(taskId: string, phase: Phase): Handoff[] {
    return this.#runs
      .handoffs(taskId, phase)
      .map(storedHandoff)
      .filter((h): h is Handoff => h !== undefined);
  }

  #close(tx: Tx, run: RunRow, input: Parameters<typeof closeRun>[2]): void {
    if (!closeRun(tx, run.id, input)) throw new Rejected(staleRun());
  }

  #transition(tx: Tx, input: TransitionTaskInput): void {
    const result = applyTransition(tx, input);
    if (!result.ok) {
      throw new Rejected(
        fail("transition_rejected", `${result.error.code}: ${result.error.message}`),
      );
    }
  }

  #write<T>(fn: (tx: Tx) => Outcome<T>): Outcome<T> {
    try {
      return this.#db.transaction(fn, { behavior: "immediate" });
    } catch (error) {
      if (error instanceof Rejected) return error.failure;
      throw error;
    }
  }
}

const staleRun = () =>
  fail(
    "invalid_run_token",
    "el Run se cerró mientras corría la llamada: esta sesión ya no es la activa",
  );

function storedHandoff(value: unknown): Handoff | undefined {
  const parsed = parseHandoff(value);
  return parsed.success ? parsed.data : undefined;
}

type ImplementationHandoff = Extract<Handoff, { phase: "implementation" }>;
type VerificationHandoff = Extract<Handoff, { phase: "verification" }>;

const isImplementation = (h: Handoff): h is ImplementationHandoff => h.phase === "implementation";
const isVerification = (h: Handoff): h is VerificationHandoff => h.phase === "verification";

/** Los ids del handoff deben ser exactamente los criterios de la spec aprobada. */
function checkCriteria(
  spec: Spec,
  ids: string[],
  path: string,
  missingMessage: string,
): Outcome<null> {
  const expected = new Set(spec.content.criteria.map((c) => c.id));
  const issues: HandoffError[] = [];
  ids.forEach((id, i) => {
    if (!expected.has(id)) {
      issues.push({
        path: `${path}[${i}]`,
        message: `la spec aprobada no tiene el criterio ${id}`,
      });
    }
  });
  for (const id of expected) {
    if (!ids.includes(id)) issues.push({ path, message: `el criterio ${id} ${missingMessage}` });
  }
  if (issues.length > 0) {
    return fail("spec_mismatch", `el handoff no cubre los criterios de la spec v${spec.version}`, {
      issues,
    });
  }
  return { ok: true, data: null };
}
