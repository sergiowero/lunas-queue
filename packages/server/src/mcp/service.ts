// Lógica de las tools del LunasQ MCP, sin transporte (docs/design.md §MCPs y skills, ADR
// uw-15-mcp-tools). Cada llamada pasa por el mismo orden de guardas: run token de un Run activo,
// tool permitida en la fase del Run y get_task_context ya leído. Las tools de salida escriben el
// handoff, el cierre del Run y la transición de la tarea en una sola transacción IMMEDIATE. La
// fase de verificación (ADR uw-23-verificacion) agrega los hooks de fase, la evidencia de los
// revisores, el tope de iteraciones del proyecto y la etiqueta de riesgo.

import { randomUUID } from "node:crypto";
import {
  appendChecklist,
  applyTaskTitle,
  applyTransition,
  closeRun,
  consecutiveFailures,
  createQuestion,
  type LunasqDatabase,
  latestChecklist,
  listEvents,
  listQuestions,
  ProjectRepository,
  RunRepository,
  type RunRow,
  RunSubagentRepository,
  recordVerdict,
  SpecRepository,
  TaskRepository,
  type TransitionTaskInput,
  type Tx,
} from "@lunasq/db";
import { checkReviewerEvidence, maxVerificationIterations } from "@lunasq/domain";
import {
  type AskHumanInput,
  type ChecklistItem,
  DELIVERY_CONFLICT,
  DeliveryConflictPayload,
  type Handoff,
  type HandoffError,
  type HandoffPhase,
  type HookPoint,
  type MustFixFinding,
  type Phase,
  parseHandoff,
  REVIEWER_NAMES,
  type ReportFailureInput,
  type RunReviewerInput,
  type Spec,
  type TaskContext,
  TEST_GATE_EXECUTED,
  TestGateExecutedPayload,
  type TestGateTrigger,
  type UpdateChecklistInput,
  VERDICT_RECORDED,
} from "@lunasq/schemas";
import type { CopilotReviewerExecutor } from "./copilot-reviewer.ts";
import type { CommitVerifier, PhaseHooks, TestGate } from "./ports.ts";

export const TOOL_NAMES = [
  "get_task_context",
  "submit_spec",
  "ask_human",
  "update_checklist",
  "submit_for_verification",
  "run_reviewer",
  "submit_verdict",
  "report_failure",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const ALL_PHASES: readonly Phase[] = ["refine", "implement", "verify", "deliver"];

/**
 * Rechazos del pass que el implementador puede corregir (worktree sucio, HEAD movido). En vez de
 * dejar al verificador sin salida, el pass se convierte en reject con un must-fix que vuelve la
 * tarea a implementación, donde el agente commitea, ignora o reconstruye su HEAD.
 */
const GIT_REWORK_CODES: ReadonlySet<McpErrorCode> = new Set(["dirty_worktree", "head_changed"]);

/** Reject con un must-fix de git que reemplaza un pass refusado por el estado del worktree. */
function gitReworkHandoff(handoff: VerificationHandoff, error: McpError): VerificationHandoff {
  const paths = (error.issues ?? []).map((issue) => issue.path);
  const finding: MustFixFinding = {
    severity: "major",
    file: paths[0] ?? ".",
    evidence: [
      `LunasQ no aceptó el pass: ${error.message}.`,
      ...(paths.length > 0 ? [`Archivos: ${paths.join(", ")}.`] : []),
      "Corrige el estado de git: commitea lo que sea del cambio, ignora lo generado por herramientas y no toques archivos ajenos. Luego vuelve a submit_for_verification.",
    ].join(" "),
    source: "approver",
  };
  return { ...handoff, body: { ...handoff.body, verdict: "reject", mustFix: [finding] } };
}

/** Fases del Run en las que cada tool se acepta. */
export const TOOL_PHASES: Readonly<Record<ToolName, readonly Phase[]>> = {
  get_task_context: ALL_PHASES,
  ask_human: ALL_PHASES,
  report_failure: ALL_PHASES,
  submit_spec: ["refine"],
  update_checklist: ["implement"],
  submit_for_verification: ["implement"],
  run_reviewer: ["verify"],
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
  // Un pass sobre un HEAD distinto del que pasó el gate de submit_for_verification.
  | "head_changed"
  | "verdict_already_recorded"
  // Un revisor reportado que no aparece en los hooks del Run, u omitido que sí corrió.
  | "reviewer_evidence_mismatch"
  | "reviewer_execution_unavailable"
  | "reviewer_execution_failed"
  | "reviewer_already_running"
  // Un hook de fase con política block falló: la tarea pasó a needs_human.
  | "hook_blocked"
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
  phaseHooks: PhaseHooks;
  copilotReviewers?: CopilotReviewerExecutor;
}

export class LunasqMcpService {
  readonly #db: LunasqDatabase;
  readonly #runs: RunRepository;
  readonly #specs: SpecRepository;
  readonly #projects: ProjectRepository;
  readonly #tasks: TaskRepository;
  readonly #testGate: TestGate;
  readonly #commits: CommitVerifier;
  readonly #hooks: PhaseHooks;
  readonly #subagents: RunSubagentRepository;
  readonly #copilotReviewers: CopilotReviewerExecutor | undefined;
  readonly #reviewersInFlight = new Set<string>();
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
    this.#hooks = deps.phaseHooks;
    this.#subagents = new RunSubagentRepository(deps.db);
    this.#copilotReviewers = deps.copilotReviewers;
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
        number: task.number,
        intent: task.intent,
        title: task.title,
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
      // El implementador recibe solo los must-fix del último reject; el historial es del verificador.
      verificationHistory:
        run.phase === "verify"
          ? this.#storedHandoffs(task.id, "verify").filter(isVerification)
          : [],
      rework: run.phase === "implement" ? this.#rework(task.id) : null,
      deliveryConflict: run.phase === "implement" ? this.#deliveryConflict(task.id) : null,
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
    const { assumptions: _assumptions, title, ...content } = parsed.data.body;
    return this.#write((tx) => {
      this.#close(tx, run, { result: "success", handoff: parsed.data });
      const result = this.#specs.applySubmit(tx, run.taskId, content);
      if (!result.ok) throw new Rejected(fail("transition_rejected", result.error.message));
      applyTaskTitle(tx, run.taskId, title);
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

  async runReviewer(run: RunRow, input: RunReviewerInput): Promise<Outcome<{ output: string }>> {
    if (run.agentKind !== "copilot" || !this.#copilotReviewers) {
      return fail(
        "reviewer_execution_unavailable",
        "run_reviewer solo está disponible cuando Copilot CLI es el proveedor de verificación",
      );
    }
    const key = `${run.id}:${input.reviewer}`;
    if (this.#reviewersInFlight.has(key)) {
      return fail("reviewer_already_running", `${input.reviewer} ya está ejecutándose en este Run`);
    }
    const task = this.#tasks.get(run.taskId);
    if (!task?.worktreePath) return fail("no_worktree", "la tarea no tiene worktree registrado");

    this.#reviewersInFlight.add(key);
    const agentId = `copilot-${randomUUID()}`;
    this.#subagents.recordStart(run.id, { agentId, agentType: input.reviewer });
    try {
      const result = await this.#copilotReviewers.run({
        run,
        worktreePath: task.worktreePath,
        agentId,
        reviewer: input.reviewer,
        instructions: input.instructions,
      });
      this.#subagents.recordStop(run.id, {
        agentId,
        agentType: input.reviewer,
        transcriptPath: result.transcriptPath,
      });
      return { ok: true, data: { output: result.output } };
    } catch (error) {
      return fail(
        "reviewer_execution_failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.#reviewersInFlight.delete(key);
    }
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
    // Tras un hook bloqueado la tarea ya escaló: un reintento no vuelve a correr hooks ni gate.
    const moved = notRunning(task, "in_progress");
    if (moved) return moved;

    const worktreePath = task.worktreePath;
    const rejected = await this.#gated(run, () =>
      this.#checkWorktree(run, handoff, worktreePath, project),
    );
    if (rejected) return rejected;
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

  async submitVerdict(
    run: RunRow,
    input: unknown,
  ): Promise<Outcome<{ verdict: "pass" | "reject" }>> {
    const parsed = this.#parse(run, input, "verification");
    if (!parsed.ok) return parsed;
    let handoff = parsed.data;
    const spec = this.#specs.approved(run.taskId);
    if (!spec) return fail("no_approved_spec", "la tarea no tiene spec aprobada");
    const coverage = checkCriteria(
      spec,
      handoff.body.criteriaVerdicts.map((c) => c.criterionId),
      "body.criteriaVerdicts",
      "no tiene veredicto",
    );
    if (!coverage.ok) return coverage;

    // Si el Run ya registró un veredicto, la transacción decide (idempotente o
    // verdict_already_recorded) sin volver a comprobar evidencia, correr la suite ni los hooks.
    if (this.#runs.get(run.id)?.handoff === null) {
      // Tras un hook bloqueado la tarea ya escaló: un reintento no vuelve a correr hooks ni gate.
      const moved = notRunning(this.#taskAndProject(run).task, "verification");
      if (moved) return moved;
      const issues = checkReviewerEvidence(handoff.body, this.#subagents.forRun(run.id));
      if (issues.length > 0) {
        return fail(
          "reviewer_evidence_mismatch",
          "los revisores del veredicto no coinciden con los registrados por los hooks del Run",
          { issues },
        );
      }
      const rejected = await this.#gated(run, async () => {
        // Antes de aceptar un pass, LunasQ vuelve a correr la suite.
        const pass = handoff.body.verdict === "pass" ? await this.#checkPass(run) : null;
        if (pass && GIT_REWORK_CODES.has(pass.error.code)) {
          // El estado de git lo arregla el implementador: el Run cierra como reject con must-fix.
          handoff = gitReworkHandoff(handoff, pass.error);
        } else if (pass) {
          return pass;
        }
        return this.#runHooks(run, "after_verification", handoff.body.verdict);
      });
      if (rejected) return rejected;
    }

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
      const { body } = handoff;
      const summary = {
        runId: run.id,
        verdict: body.verdict,
        iteration: run.iteration,
        riskLabel: body.riskLabel,
        mustFix: body.mustFix.length,
        refuted: body.refuted.length,
        skippedReviewers: REVIEWER_NAMES.filter((n) => body.reviewers[n].status === "skipped"),
      };
      if (body.verdict === "reject") {
        const { project } = this.#taskAndProject(run);
        this.#close(tx, run, { result: "success", handoff });
        // Con el tope del proyecto alcanzado, la máquina de estados manda la tarea a needs_human.
        this.#transition(tx, {
          taskId: run.taskId,
          actor: "agent",
          command: { type: "verdict_rework", maxIterations: maxVerificationIterations(project) },
          expected: { state: "verification", subState: "running" },
        });
        recordVerdict(tx, run.taskId, summary);
        return { ok: true, data: { verdict: "reject" } };
      }
      // Pass: el Run sigue abierto y la entrega (UW-26) emite verdict_pass tras crear el PR; la
      // arranca el evento verification.verdict_recorded.
      const task = this.#tasks.get(run.taskId);
      if (task?.state !== "verification" || task.subState !== "running") {
        throw new Rejected(fail("transition_rejected", "la tarea no está en verification/running"));
      }
      this.#runs.recordHandoff(run.id, handoff);
      recordVerdict(tx, run.taskId, summary);
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

  /**
   * Corre `check` con el candado del Run: mientras corre un gate, otra llamada del mismo Run no
   * lanza una segunda suite.
   */
  async #gated(
    run: RunRow,
    check: () => Promise<Extract<Outcome<never>, { ok: false }> | null>,
  ): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    if (this.#gating.has(run.id)) {
      return fail(
        "gate_in_progress",
        "ya corre un gate de tests para este Run; espera su resultado",
      );
    }
    this.#gating.add(run.id);
    try {
      return await check();
    } finally {
      this.#gating.delete(run.id);
    }
  }

  /**
   * Antes de aceptar un pass: worktree limpio, HEAD en el commit que pasó el gate de
   * `submit_for_verification` y gate en verde otra vez; null si todo pasa. Así el verificador no
   * puede aprobar un commit propio que, por ejemplo, borre los tests en rojo.
   */
  async #checkPass(run: RunRow): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    const { task, project } = this.#taskAndProject(run);
    const worktreePath = task.worktreePath;
    if (!worktreePath) return fail("no_worktree", "la tarea no tiene worktree registrado");
    const expected = this.#gatedHead(run.taskId);
    // La prueba de reversión del verificador toca el código: el gate corre sobre lo commiteado.
    const unchanged = async () =>
      (await this.#dirty(worktreePath)) ?? (await this.#sameHead(worktreePath, expected));
    const before = await unchanged();
    if (before) return before;
    const gate = await this.#runGate(run, worktreePath, project, "verdict_pass");
    if (gate) return gate;
    // La suite puede tardar minutos: el worktree no debe haberse movido mientras corría.
    return unchanged();
  }

  /** Sha que probó el último gate en verde de `submit_for_verification` de la tarea. */
  #gatedHead(taskId: string): string | null {
    let head: string | null = null;
    for (const event of listEvents(this.#db, taskId)) {
      if (event.type !== TEST_GATE_EXECUTED) continue;
      const payload = TestGateExecutedPayload.safeParse(event.payload);
      if (!payload.success || payload.data.trigger !== "submit_for_verification") continue;
      if (payload.data.passed) head = payload.data.headSha;
    }
    return head;
  }

  async #sameHead(
    worktreePath: string,
    expected: string | null,
  ): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    const head = await this.#commits.head(worktreePath);
    if (expected !== null) {
      if (head === expected) return null;
      // Cerrar un Run escribe y a veces commitea la evidencia después del gate del implementador.
      // Si los commits intermedios solo tocan `lunasq/tasks/` no cambian el código, y el gate del
      // pass corre sobre el HEAD actual: el veredicto sigue juzgando exactamente lo que se prueba.
      if (
        head !== null &&
        (await this.#commits.onlyEvidenceBetween({
          worktreePath,
          from: expected,
          to: head,
        }))
      ) {
        return null;
      }
    }
    return fail(
      "head_changed",
      expected === null
        ? "no hay un gate en verde de submit_for_verification con el que comparar el HEAD"
        : `el HEAD del worktree (${head ?? "ilegible"}) no es el commit que pasó el gate de submit_for_verification (${expected})`,
    );
  }

  async #dirty(worktreePath: string): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    const dirty = await this.#commits.uncommitted(worktreePath);
    if (dirty.length === 0) return null;
    return fail("dirty_worktree", "el worktree tiene cambios sin commitear", {
      issues: dirty.map((file) => ({ path: file, message: "cambio sin commitear" })),
    });
  }

  async #runGate(
    run: RunRow,
    worktreePath: string,
    project: { testCommand?: string | null },
    trigger: TestGateTrigger,
  ): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    // El gate lo corre LunasQ sobre lo commiteado: lo que el agente diga de sus tests no cuenta.
    const gate = await this.#testGate.run({
      taskId: run.taskId,
      runId: run.id,
      worktreePath,
      command: project.testCommand ?? null,
      trigger,
    });
    if (!gate.passed) {
      return fail("test_gate_failed", "el gate de tests está en rojo", { output: gate.output });
    }
    return null;
  }

  /** Commits del branch, worktree limpio y gate de tests en verde; null si todo pasa. */
  async #checkWorktree(
    run: RunRow,
    handoff: ImplementationHandoff,
    worktreePath: string,
    project: { baseBranch: string; testCommand?: string | null },
  ): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    const dirty = await this.#dirty(worktreePath);
    if (dirty) return dirty;
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
    // Los hooks corren antes del gate: así la suite prueba el HEAD con lo que commiteen y el
    // verificador se despacha cuando ya terminaron.
    for (const point of ["after_implementation", "before_verification"] as const) {
      const blocked = await this.#runHooks(run, point);
      if (blocked) return blocked;
    }
    return this.#runGate(run, worktreePath, project, "submit_for_verification");
  }

  /** Hooks del punto; null si no bloqueó. Un punto bloqueado ya escaló la tarea (HookService). */
  async #runHooks(
    run: RunRow,
    point: HookPoint,
    phaseResult?: string,
  ): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    const result = await this.#hooks.run({
      taskId: run.taskId,
      point,
      runId: run.id,
      ...(phaseResult === undefined ? {} : { phaseResult }),
    });
    if (result.outcome !== "blocked") return null;
    const where = result.failedScript ? ` en ${result.failedScript}` : "";
    return fail(
      "hook_blocked",
      `el punto ${point} bloqueó${where}${result.escalated ? ": la tarea pasó a needs_human" : ""}`,
      result.error ? { output: result.error } : {},
    );
  }

  /** Must-fix del último veredicto si fue reject; null si no hay o si el último fue pass. */
  #rework(taskId: string): TaskContext["rework"] {
    const latest = this.#runs.latestHandoff(taskId, "verify");
    const handoff = latest ? storedHandoff(latest.handoff) : undefined;
    if (!latest || !handoff || !isVerification(handoff) || handoff.body.verdict !== "reject") {
      return null;
    }
    return { runId: latest.runId, iteration: latest.iteration, mustFix: handoff.body.mustFix };
  }

  /** El conflicto de entrega más reciente, mientras no haya un veredicto posterior (ADR uw-26-entrega). */
  #deliveryConflict(taskId: string): TaskContext["deliveryConflict"] {
    let conflict: TaskContext["deliveryConflict"] = null;
    for (const event of listEvents(this.#db, taskId)) {
      if (event.type === VERDICT_RECORDED) conflict = null;
      else if (event.type === DELIVERY_CONFLICT) {
        const parsed = DeliveryConflictPayload.safeParse(event.payload);
        if (parsed.success) conflict = parsed.data;
      }
    }
    return conflict;
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

/** Rechazo sin efectos si la tarea ya no está en `<state>/running` (p. ej. escaló a needs_human). */
function notRunning(task: { state: string; subState: string | null }, state: string) {
  if (task.state === state && task.subState === "running") return null;
  return fail(
    "transition_rejected",
    `la tarea está en ${task.state}${task.subState ? `/${task.subState}` : ""}, no en ${state}/running`,
  );
}

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
