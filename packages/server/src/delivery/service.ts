// Fase de entrega (docs/design.md §Entrega, ADR uw-26-entrega). Corre dentro del Run del
// verificador, sin agente, cuando éste registró un pass: hook `before_delivery`, rebase sobre la
// base, trailers en los commits, suite final, cierre del Run y archivo de evidencia, push, PR con
// intent, criterios, evidencia y etiqueta de riesgo, `after_delivery` y `verdict_pass`. Un conflicto
// o una suite en rojo regresan la tarea a in_progress; cualquier otro fallo la escala. Cada paso se
// puede repetir: una entrega a medias se retoma con `deliver` o `recover`.
import type { GitAdapter, GitHubAdapter } from "@lunasq/adapters";
import {
  appendEvent,
  applyTransition,
  type LunasqDatabase,
  listEvents,
  ProjectRepository,
  RunRepository,
  type RunRow,
  SpecRepository,
  TaskPrRepository,
  TaskRepository,
  transitionTask,
} from "@lunasq/db";
import {
  commitTrailers,
  deliveryFacts,
  maxVerificationIterations,
  prBody,
  prTitle,
  riskPrLabel,
} from "@lunasq/domain";
import {
  DELIVERY_CONFLICT,
  DELIVERY_OUTPUT_LIMIT,
  type DeliveryConflictPayload,
  type DeliveryConflictReason,
  evidencePath,
  type Handoff,
  type Project,
  parseHandoff,
  type RunResult,
  TASK_TRANSITIONED,
} from "@lunasq/schemas";
import type { TestGate } from "../mcp/ports.ts";
import { type PhaseHooks, tailOf } from "../mcp/ports.ts";
import { KeyedLock } from "../worktrees/keyed-lock.ts";
import type { EnsuredWorktree } from "../worktrees/service.ts";

export type DeliveryResult =
  | { status: "delivered"; prUrl: string; created: boolean }
  /** La tarea volvió a in_progress (o escaló, si ya van demasiados conflictos). */
  | { status: "conflict"; reason: DeliveryConflictReason }
  /** Un hook con política block detuvo la entrega; HookService ya escaló la tarea. */
  | { status: "blocked" }
  | { status: "escalated"; error: string }
  | {
      status: "skipped";
      reason: "task_not_found" | "not_delivering" | "no_pass_verdict" | "no_spec";
    };

export interface DeliveryServiceDeps {
  db: LunasqDatabase;
  git: Pick<
    GitAdapter,
    "fetch" | "rebase" | "listCommits" | "addTrailers" | "push" | "resolveCommit"
  >;
  github: Pick<GitHubAdapter, "createPr" | "addLabels">;
  hooks: PhaseHooks;
  testGate: TestGate;
  /** WorktreeService.ensure: la entrega corre en el worktree de la tarea. */
  worktrees: { ensure(taskId: string): Promise<EnsuredWorktree> };
  /** PhaseDispatcher: cierra el Run, su pane y deja la sección de evidencia. */
  runs: {
    closeRun(runId: string, input: { result: RunResult; failureReason?: string }): Promise<unknown>;
  };
  /** EvidenceService: sin él, el archivo de evidencia no viaja en el PR. */
  evidence?: { commit(taskId: string): Promise<string | null> };
  remote?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Longitud máxima de la nota de un escalamiento (TaskTransitionedPayload.note). */
const NOTE_LIMIT = 2000;

/** Parada de la entrega que no es un error: se devuelve tal cual. */
class Stop extends Error {
  readonly result: DeliveryResult;

  constructor(result: DeliveryResult) {
    super(result.status);
    this.result = result;
  }
}

export class DeliveryService {
  readonly #deps: DeliveryServiceDeps;
  readonly #tasks: TaskRepository;
  readonly #projects: ProjectRepository;
  readonly #runs: RunRepository;
  readonly #specs: SpecRepository;
  readonly #prs: TaskPrRepository;
  readonly #remote: string;
  /** Una entrega a la vez por tarea: el outbox entrega al menos una vez. */
  readonly #locks = new KeyedLock();

  constructor(deps: DeliveryServiceDeps) {
    this.#deps = deps;
    this.#tasks = new TaskRepository(deps.db);
    this.#projects = new ProjectRepository(deps.db);
    this.#runs = new RunRepository(deps.db);
    this.#specs = new SpecRepository(deps.db);
    this.#prs = new TaskPrRepository(deps.db);
    this.#remote = deps.remote ?? "origin";
  }

  /** Entrega la tarea cuyo verificador dio pass. Idempotente. */
  deliver(taskId: string): Promise<DeliveryResult> {
    return this.#locks.run(taskId, () => this.#deliver(taskId));
  }

  /**
   * Retoma las entregas que un reinicio dejó a medias: tareas en verification/running con un pass
   * guardado. Una verificación en curso (sin pass) no se toca.
   */
  async recover(): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];
    for (const task of this.#tasks.list({ state: "verification" })) {
      if (task.subState !== "running") continue;
      const result = await this.deliver(task.id);
      if (result.status !== "skipped") results.push(result);
    }
    return results;
  }

  async #deliver(taskId: string): Promise<DeliveryResult> {
    const task = this.#tasks.get(taskId);
    if (!task) return { status: "skipped", reason: "task_not_found" };
    if (task.state !== "verification" || task.subState !== "running") {
      return { status: "skipped", reason: "not_delivering" };
    }
    const latest = this.#runs.latestHandoff(taskId, "verify");
    const parsed = latest ? parseHandoff(latest.handoff) : null;
    if (!latest || !parsed?.success || parsed.data.phase !== "verification") {
      return { status: "skipped", reason: "no_pass_verdict" };
    }
    const verification = parsed.data;
    if (verification.body.verdict !== "pass") {
      return { status: "skipped", reason: "no_pass_verdict" };
    }
    const run = this.#runs.get(latest.runId);
    const spec = this.#specs.approved(taskId);
    const project = this.#projects.get(task.projectId);
    if (!run || !project) return { status: "skipped", reason: "task_not_found" };
    if (!spec) return { status: "skipped", reason: "no_spec" };

    try {
      return await this.#run({ taskId, intent: task.intent, run, project, spec, verification });
    } catch (error) {
      if (error instanceof Stop) return error.result;
      return this.#escalate(taskId, run, "delivery_failed", message(error));
    }
  }

  async #run(ctx: {
    taskId: string;
    intent: string;
    run: RunRow;
    project: Project;
    spec: NonNullable<ReturnType<SpecRepository["approved"]>>;
    verification: Extract<Handoff, { phase: "verification" }>;
  }): Promise<DeliveryResult> {
    const { taskId, run, project } = ctx;
    const { git, github, testGate } = this.#deps;
    const base = project.baseBranch;
    const worktree = await this.#deps.worktrees.ensure(taskId);

    await this.#hook(taskId, run, "before_delivery");

    // Integrar la base: un conflicto no se resuelve aquí, lo resuelve el implementador.
    await git.fetch({ cwd: worktree.path, remote: this.#remote, branch: base });
    const onto = `${this.#remote}/${base}`;
    const rebase = await git.rebase({ cwd: worktree.path, onto });
    if (rebase.status === "conflict") {
      return this.#conflict(ctx, { reason: "rebase_conflict", files: rebase.files, output: null });
    }

    // Trailers LunasQ-Task y LunasQ-Run en cada commit del branch.
    const commits = await git.listCommits({ cwd: worktree.path, base: onto });
    await git.addTrailers({
      cwd: worktree.path,
      base: onto,
      trailers: commitTrailers({
        taskId,
        commits,
        runs: this.#runs.forTask(taskId),
        fallbackRunId: run.id,
      }),
    });

    // Suite final sobre lo que se va a publicar.
    const gate = await testGate.run({
      taskId,
      runId: run.id,
      worktreePath: worktree.path,
      command: project.testCommand,
      trigger: "delivery",
    });
    if (!gate.passed) {
      return this.#conflict(ctx, {
        reason: "tests_failed",
        files: [],
        output: tailOf(gate.output, DELIVERY_OUTPUT_LIMIT),
      });
    }

    // El Run se cierra antes del push para que su sección de evidencia viaje en el PR.
    await this.#closeRun(run, "success");
    await this.#deps.evidence?.commit(taskId);

    await git.push({ cwd: worktree.path, remote: this.#remote, branch: worktree.branch });

    const { pr, created } = await github.createPr({
      cwd: worktree.path,
      head: worktree.branch,
      base,
      title: prTitle(ctx.intent),
      body: prBody({
        taskId,
        runId: run.id,
        intent: ctx.intent,
        specVersion: ctx.spec.version,
        criteria: ctx.spec.content.criteria,
        verification: ctx.verification.body,
        evidencePath: evidencePath(taskId),
        baseBranch: base,
      }),
    });
    // La etiqueta es para priorizar la revisión: si falla, el PR sigue siendo válido.
    await github
      .addLabels({
        cwd: worktree.path,
        url: pr.url,
        labels: [riskPrLabel(ctx.verification.body.riskLabel)],
      })
      .catch(() => undefined);
    // Repetir el registro del mismo PR abierto no escribe nada; otro PR abierto lanza TaskPrError.
    this.#prs.recordPrOpened(taskId, pr.url);

    // Un hook que commitea (HookService incluye sus cambios en un commit) deja HEAD por delante de
    // lo publicado: un segundo push los lleva al PR.
    const published = await git.resolveCommit({ cwd: worktree.path, ref: "HEAD" });
    await this.#hook(taskId, run, "after_delivery", pr.url);
    if ((await git.resolveCommit({ cwd: worktree.path, ref: "HEAD" })) !== published) {
      await git.push({ cwd: worktree.path, remote: this.#remote, branch: worktree.branch });
    }

    const facts = deliveryFacts({
      criteria: ctx.spec.content.criteria,
      implementation: this.#implementation(taskId),
      verification: ctx.verification.body,
    });
    const passed = transitionTask(this.#deps.db, {
      taskId,
      actor: "system",
      command: { type: "verdict_pass", ...facts, testGatePassed: true, prCreated: true },
      expected: { state: "verification", subState: "running" },
    });
    if (!passed.ok) {
      throw new Error(`verdict_pass rechazado: ${passed.error.code}: ${passed.error.message}`);
    }
    return { status: "delivered", prUrl: pr.url, created };
  }

  /** Último handoff de implementación guardado, para comprobar que cada criterio tiene tests. */
  #implementation(taskId: string) {
    for (const stored of this.#runs.handoffs(taskId, "implement").reverse()) {
      const parsed = parseHandoff(stored);
      if (parsed.success && parsed.data.phase === "implementation") return parsed.data.body;
    }
    return null;
  }

  async #hook(
    taskId: string,
    run: RunRow,
    point: "before_delivery" | "after_delivery",
    prUrl?: string,
  ) {
    const result = await this.#deps.hooks.run({
      taskId,
      point,
      runId: run.id,
      ...(prUrl !== undefined && { prUrl }),
    });
    if (result.outcome !== "blocked") return;
    if (!result.escalated) {
      this.#escalateTask(taskId, "hook_failed", result.error ?? `el punto ${point} bloqueó`);
    }
    throw new Stop({ status: "blocked" });
  }

  /**
   * Conflicto de integración o suite en rojo: la tarea vuelve a in_progress sin subir la
   * iteración y el implementador recibe qué lo causó. Con tantos conflictos como iteraciones
   * permite el proyecto, escala en vez de repetir el ciclo.
   */
  async #conflict(
    ctx: { taskId: string; run: RunRow; project: Project },
    detail: { reason: DeliveryConflictReason; files: string[]; output: string | null },
  ): Promise<DeliveryResult> {
    const { taskId, run, project } = ctx;
    const previous = this.#conflicts(taskId);
    if (previous >= maxVerificationIterations(project)) {
      return this.#escalate(
        taskId,
        run,
        "delivery_failed",
        `${previous} entregas seguidas volvieron a implementación (${detail.reason})`,
      );
    }
    await this.#closeRun(run, "success");
    const payload: DeliveryConflictPayload = {
      runId: run.id,
      reason: detail.reason,
      baseBranch: project.baseBranch,
      files: detail.files,
      output: detail.output,
    };
    this.#deps.db.transaction(
      (tx) => {
        const moved = applyTransition(tx, {
          taskId,
          actor: "system",
          command: { type: "delivery_conflict" },
          expected: { state: "verification", subState: "running" },
        });
        if (!moved.ok) throw new Error(`delivery_conflict rechazado: ${moved.error.message}`);
        appendEvent(
          tx,
          { taskId, type: DELIVERY_CONFLICT, actor: "system", payload },
          { publish: true },
        );
      },
      { behavior: "immediate" },
    );
    return { status: "conflict", reason: detail.reason };
  }

  /**
   * Conflictos de entrega seguidos: desde el último `resume` (un humano que reanuda concede otra
   * vuelta) o el último `verdict_pass` (un PR entregado que después quedó en conflicto empieza de
   * cero, ADR pr-en-conflicto).
   */
  #conflicts(taskId: string): number {
    let count = 0;
    for (const event of listEvents(this.#deps.db, taskId)) {
      if (event.type === DELIVERY_CONFLICT) count += 1;
      else if (event.type === TASK_TRANSITIONED) {
        const payload = event.payload as { command?: string };
        if (payload.command === "resume" || payload.command === "verdict_pass") count = 0;
      }
    }
    return count;
  }

  async #escalate(
    taskId: string,
    run: RunRow,
    reason: "delivery_failed",
    note: string,
  ): Promise<DeliveryResult> {
    // El Run no queda abierto con la tarea en needs_human; "cancelled" no cuenta como fallo.
    if (!this.#runs.get(run.id)?.endedAt) {
      await this.#closeRun(run, "cancelled", `delivery_failed: ${note}`).catch(() => undefined);
    }
    this.#escalateTask(taskId, reason, note);
    return { status: "escalated", error: note };
  }

  #escalateTask(taskId: string, reason: "delivery_failed" | "hook_failed", note: string) {
    transitionTask(this.#deps.db, {
      taskId,
      actor: "system",
      command: { type: "escalate", reason, note: note.slice(0, NOTE_LIMIT) },
      expected: { state: "verification", subState: "running" },
    });
  }

  async #closeRun(run: RunRow, result: RunResult, failureReason?: string) {
    // Un Run ya cerrado (entrega retomada) no se vuelve a cerrar.
    if (this.#runs.get(run.id)?.endedAt) return;
    await this.#deps.runs.closeRun(run.id, {
      result,
      ...(failureReason && { failureReason }),
    });
  }
}
