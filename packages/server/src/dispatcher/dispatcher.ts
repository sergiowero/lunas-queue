// Dispatcher (docs/design.md §Secuencia de despacho, ADR 0002, ADR 0004, ADR 0014, ADR
// uw-16-dispatcher). Implementa el puerto `Dispatcher` del scheduler: el claim es atómico en la
// base y el resto de la secuencia (worktree, pane, agente, confianza, metadata, prompt) corre
// después, en segundo plano, guardando cada paso en el Run. Así un despacho que se cae a medias se
// retoma sin duplicar panes ni agentes, y repetir una decisión ya aplicada da `stale_state`.
import { randomUUID } from "node:crypto";
import {
  type HerdrAdapter,
  type HerdrAgent,
  isHerdrError,
  showsTrustDialog,
  TRUST_ACCEPT_KEYS,
} from "@lunasq/adapters";
import {
  type ClaimErrorCode,
  type CloseRunInput,
  claimRun,
  type FailRunResult,
  type LunasqDatabase,
  ProjectRepository,
  RunRepository,
  type RunRow,
  TaskWorktreeRepository,
} from "@lunasq/db";
import {
  agentArgs,
  type DispatchDecision,
  DispatchRuleError,
  type ProjectConfigReader,
  phaseProfile,
  phasePrompt,
  resolveSession,
  runEnv,
} from "@lunasq/domain";
import {
  type Project,
  type SchedulablePhase,
  SchedulablePhase as SchedulablePhaseSchema,
  SchedulerConfig,
  type SchedulerConfigInput,
} from "@lunasq/schemas";
import { DEFAULT_GATE_TIMEOUT_MS } from "../mcp/ports.ts";
import type { Dispatcher } from "../scheduler/scheduler.ts";
import { KeyedLock } from "../worktrees/keyed-lock.ts";
import { isWorktreeError, type WorktreeService } from "../worktrees/service.ts";

/** Cuánto esperar a que Claude Code quede listo tras aceptar la confianza de carpeta. */
export const DEFAULT_TRUST_TIMEOUT_MS = 15_000;
/**
 * `MCP_TOOL_TIMEOUT` de Claude Code en el pane: `submit_for_verification` corre el gate de tests
 * dentro de la llamada (ADR uw-15-mcp-tools), así que debe cubrir su timeout con margen.
 */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = DEFAULT_GATE_TIMEOUT_MS + 5 * 60_000;
/** `--timeout` de `agent start`: lo que tarda el agente en quedar listo para prompts. */
export const DEFAULT_START_TIMEOUT_MS = 30_000;
/** Líneas de la pantalla del agente que se leen para reconocer el diálogo de confianza. */
const SCREEN_LINES = 60;

export type DispatchErrorCode =
  | ClaimErrorCode
  | "run_not_found"
  | "agent_blocked"
  | "agent_name_taken"
  | "profile_conflict";

export class DispatchError extends Error {
  readonly code: DispatchErrorCode;

  constructor(code: DispatchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DispatchError";
    this.code = code;
  }
}

export function isDispatchError(err: unknown, code?: DispatchErrorCode): err is DispatchError {
  return err instanceof DispatchError && (code === undefined || err.code === code);
}

/**
 * Quien observa los agentes vivos (UW-17: señales de herdr, nudges, timeout de fase). El
 * dispatcher solo avisa cuándo empieza y cuándo termina cada Run.
 */
export interface RunObserver {
  watch(run: RunRow, agent: HerdrAgent): void;
  unwatch(runId: string): void;
}

/** `runId` es null si el fallo no es de un Run (p. ej. la lectura de `recover`). */
export type DispatchErrorHandler = (error: Error, runId: string | null) => void;

export interface PhaseDispatcherOptions {
  db: LunasqDatabase;
  herdr: HerdrAdapter;
  worktrees: WorktreeService;
  /** Archivo MCP estable con `${LUNASQ_RUN_TOKEN}` (ADR 0002); ver `ensureMcpConfig`. */
  mcpConfigPath: string;
  projects?: ProjectConfigReader;
  /** Los mismos límites que el scheduler: el claim los revalida (ADR 0014). */
  config?: SchedulerConfigInput;
  /** Variables extra del pane de cada agente (telemetría, PATH de pruebas). */
  paneEnv?: Record<string, string>;
  observer?: RunObserver;
  newSessionId?: () => string;
  startTimeoutMs?: number;
  trustTimeoutMs?: number;
  onError?: DispatchErrorHandler;
}

export class PhaseDispatcher implements Dispatcher {
  private readonly db: LunasqDatabase;
  private readonly herdr: HerdrAdapter;
  private readonly worktrees: WorktreeService;
  private readonly mcpConfigPath: string;
  private readonly projects: ProjectConfigReader;
  private readonly config: SchedulerConfig;
  private readonly paneEnv: Record<string, string>;
  private readonly observer: RunObserver | undefined;
  private readonly newSessionId: () => string;
  private readonly startTimeoutMs: number;
  private readonly trustTimeoutMs: number;
  private readonly onError: DispatchErrorHandler;
  private readonly runs: RunRepository;
  private readonly tasks: TaskWorktreeRepository;
  /** Un lanzamiento por Run a la vez: `recover` y `dispatch` pueden coincidir. */
  private readonly locks = new KeyedLock();
  /** Cierres de un mismo Run en orden; no esperan al lanzamiento (puede tardar minutos). */
  private readonly closeLocks = new KeyedLock();
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(opts: PhaseDispatcherOptions) {
    this.db = opts.db;
    this.herdr = opts.herdr;
    this.worktrees = opts.worktrees;
    this.mcpConfigPath = opts.mcpConfigPath;
    this.projects = opts.projects ?? new ProjectRepository(opts.db);
    this.config = SchedulerConfig.parse(opts.config ?? {});
    this.paneEnv = { MCP_TOOL_TIMEOUT: String(DEFAULT_MCP_TOOL_TIMEOUT_MS), ...opts.paneEnv };
    this.observer = opts.observer;
    this.newSessionId = opts.newSessionId ?? randomUUID;
    this.startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.trustTimeoutMs = opts.trustTimeoutMs ?? DEFAULT_TRUST_TIMEOUT_MS;
    this.onError = opts.onError ?? defaultError;
    this.runs = new RunRepository(opts.db);
    this.tasks = new TaskWorktreeRepository(opts.db);
  }

  /**
   * Resuelve cuando el claim quedó confirmado (la tarea está en running y ocupa su slot) y lanza
   * el agente en segundo plano; rechaza con `DispatchError` si el claim no procede.
   */
  async dispatch(decision: DispatchDecision): Promise<void> {
    const claim = claimRun(this.db, {
      decision,
      config: this.config,
      projects: this.projects,
      sessionId: this.newSessionId(),
    });
    if (!claim.ok) throw new DispatchError(claim.error.code, claim.error.message);
    this.background(claim.run.id);
  }

  /** Retoma los Runs reclamados que no llegaron a mandar su prompt (tras una caída). */
  async recover(): Promise<void> {
    for (const run of this.runs.active()) {
      if (run.launchedAt === null) this.background(run.id);
    }
  }

  /** Espera los lanzamientos en curso (para `stop` y para tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Lanza el Run: idempotente. Cada paso se salta si ya está hecho según el Run y herdr. Un fallo
   * cierra el Run como failure (`run_failed`) y cierra su pane. Si el Run se cierra mientras se
   * lanza (cancelación durante el bootstrap), el lanzamiento se detiene y cierra lo que abrió.
   */
  launch(runId: string): Promise<RunRow> {
    return this.locks.run(runId, async () => {
      const run = this.runs.get(runId);
      if (!run) throw new DispatchError("run_not_found", `no existe el Run ${runId}`);
      if (run.endedAt !== null || run.launchedAt !== null) return run;
      try {
        return await this.launchSteps(run);
      } catch (error) {
        if (error instanceof RunClosed) {
          await this.release(run.id);
          return this.runs.get(run.id) ?? run;
        }
        try {
          await this.failRun(run.id, failureReason(error));
        } catch (failError) {
          // No tapar el error original: se reportan los dos y el pane se cierra igual.
          this.onError(asError(failError), run.id);
          await this.release(run.id).catch((e: unknown) => this.onError(asError(e), run.id));
        }
        throw error;
      }
    });
  }

  /**
   * Cierre de fase: guarda resultado, handoff e identidad de sesión y cierra el pane. Lo llama
   * quien aplica la transición de fin de fase (UW-15) o de cancelación. Idempotente.
   */
  closeRun(runId: string, input: Omit<CloseRunInput, "session">) {
    return this.closeLocks.run(runId, async () => {
      const run = this.runs.get(runId);
      if (!run) throw new DispatchError("run_not_found", `no existe el Run ${runId}`);
      if (run.endedAt !== null) {
        // Lo cerró otro (la tool de salida del MCP): queda limpiar el pane.
        await this.release(runId);
        return { closed: false, run };
      }
      const session = await this.resolveSession(run);
      const res = this.runs.close(runId, { ...input, ...(session && { session }) });
      await this.release(runId);
      return res;
    });
  }

  /**
   * Limpia el pane de un Run que ya cerró otro: las tools de salida del LunasQ MCP cierran el Run
   * en su transacción y el dispatcher solo detiene el agente (ADR uw-15-mcp-tools). Un Run abierto
   * no se toca.
   */
  releaseRun(runId: string): Promise<void> {
    return this.closeLocks.run(runId, async () => {
      if (this.runs.get(runId)?.endedAt == null) return;
      await this.release(runId);
    });
  }

  /** Run fallido: lo cierra, aplica `run_failed` si la tarea sigue en su fase y cierra el pane. */
  failRun(runId: string, reason: string): Promise<FailRunResult> {
    return this.closeLocks.run(runId, async () => {
      if (!this.runs.get(runId))
        throw new DispatchError("run_not_found", `no existe el Run ${runId}`);
      const res = this.runs.fail(runId, reason);
      // También con closed false: un lanzamiento que falla tras un cierre deja su pane abierto.
      await this.release(runId);
      return res;
    });
  }

  private background(runId: string): void {
    const job = this.launch(runId).catch((error: unknown) => this.onError(asError(error), runId));
    this.inFlight.add(job);
    void job.finally(() => this.inFlight.delete(job));
  }

  /** Lanza RunClosed si el Run se cerró mientras se lanzaba. */
  private checkOpen(runId: string): RunRow {
    const run = this.runs.get(runId);
    if (!run || run.endedAt !== null) throw new RunClosed();
    return run;
  }

  private async launchSteps(initial: RunRow): Promise<RunRow> {
    const phase = SchedulablePhaseSchema.parse(initial.phase);
    const name = requireName(initial);
    const project = this.projectOf(initial.taskId);
    const worktree = await this.worktrees.ensure(initial.taskId);
    let run = this.checkOpen(initial.id);

    let agent = await this.herdr.getAgent(name);
    if (agent && !this.owns(run, agent)) {
      throw new DispatchError(
        "agent_name_taken",
        `el agente ${name} de herdr pertenece a otro Run (pane ${agent.paneId})`,
      );
    }
    const fresh = !agent;
    if (!agent) {
      const args = this.args(project, phase, run);
      const paneId = await this.ensurePane(run, worktree, phase);
      run = this.checkOpen(run.id);
      agent = (
        await this.herdr.startAgent({
          name,
          kind: run.agentKind,
          paneId,
          args,
          timeoutMs: this.startTimeoutMs,
        })
      ).agent;
      run = this.checkOpen(run.id);
    }
    // Recién arrancado y aún cargando (herdr devuelve `agent_not_ready` con el estado del
    // momento): esperar a que quede listo o bloqueado antes de decidir.
    if (fresh && agent.status !== "idle" && agent.status !== "blocked") {
      agent = await this.herdr.waitAgent({
        name,
        until: ["idle", "blocked"],
        timeoutMs: this.startTimeoutMs,
      });
    } else if (!fresh && agent.status === "unknown") {
      agent = await this.herdr.waitAgent({
        name,
        until: ["idle", "blocked", "working", "done"],
        timeoutMs: this.startTimeoutMs,
      });
    }
    if (agent.status === "blocked") agent = await this.unblockStart(name, agent, fresh);
    run = this.checkOpen(run.id);

    const paneId = agent.paneId;
    if (run.herdrPane !== paneId || run.herdrWorkspace !== agent.workspaceId) {
      this.runs.recordPane(run.id, { workspaceId: agent.workspaceId, paneId });
    }
    await this.herdr.reportMetadata({
      paneId,
      title: `LunasQ ${phase} ${run.taskId.slice(0, 8)}`,
      tokens: { task: run.taskId, phase, iter: String(run.iteration), run: run.id },
    });
    run = this.checkOpen(run.id);
    // Solo un agente idle no recibió aún el prompt; working, blocked o done ya lo tienen.
    if (agent.status === "idle") {
      agent = await this.herdr.promptAgent({ name, text: phasePrompt(phase, run.taskId) });
    }
    const launched = this.runs.markLaunched(run.id);
    if (!launched) throw new DispatchError("run_not_found", `el Run ${run.id} desapareció`);
    // Un cierre que llegó durante el prompt ya no encontrará al lanzamiento: se cierra aquí.
    this.checkOpen(run.id);
    this.observer?.watch(launched, agent);
    return launched;
  }

  private projectOf(taskId: string): Project {
    const task = this.tasks.get(taskId);
    const project = task ? this.projects.get(task.projectId) : null;
    if (!project) throw new DispatchError("project_not_found", `sin proyecto para ${taskId}`);
    return project;
  }

  /** El agente con el nombre del Run es de este Run: lo dice su metadata o su pane guardado. */
  private owns(run: RunRow, agent: HerdrAgent): boolean {
    const owner = agent.tokens.run;
    if (owner !== undefined) return owner === run.id;
    return run.herdrPane !== null && agent.paneId === run.herdrPane;
  }

  private args(project: Project, phase: SchedulablePhase, run: RunRow) {
    try {
      return agentArgs(phaseProfile(project, phase), {
        mcpConfigPath: this.mcpConfigPath,
        sessionId: run.agentSession ?? run.id,
      });
    } catch (error) {
      if (error instanceof DispatchRuleError) {
        throw new DispatchError("profile_conflict", error.message, { cause: error });
      }
      throw error;
    }
  }

  /**
   * El pane guardado si sigue abierto, sin agente y en el worktree de la tarea (los ids de herdr
   * se reutilizan tras un reinicio); si no, uno nuevo con el entorno del Run.
   */
  private async ensurePane(
    run: RunRow,
    worktree: { workspaceId: string; rootPaneId: string; path: string },
    phase: SchedulablePhase,
  ): Promise<string> {
    if (run.herdrPane !== null) {
      const snap = await this.herdr.snapshot();
      const pane = snap.panes.find((p) => p.paneId === run.herdrPane);
      const busy = snap.agents.some((a) => a.paneId === run.herdrPane);
      if (
        pane &&
        !busy &&
        pane.workspaceId === worktree.workspaceId &&
        pane.cwd === worktree.path
      ) {
        return pane.paneId;
      }
    }
    const pane = await this.herdr.splitPane({
      paneId: worktree.rootPaneId,
      cwd: worktree.path,
      env: {
        ...this.paneEnv,
        ...runEnv({ runToken: run.runToken, taskId: run.taskId, runId: run.id, phase }),
      },
    });
    this.runs.recordPane(run.id, { workspaceId: pane.workspaceId, paneId: pane.paneId });
    return pane.paneId;
  }

  /**
   * Un worktree nuevo abre Claude Code en el diálogo de confianza de carpeta (ADR 0004). Se acepta
   * solo si la pantalla muestra ese diálogo. Otro `blocked` en un agente recién arrancado falla el
   * Run; en uno reutilizado (caída después del prompt) es un permiso de la fase y se respeta.
   */
  private async unblockStart(name: string, agent: HerdrAgent, fresh: boolean): Promise<HerdrAgent> {
    const screen = await this.herdr.readAgent({ name, lines: SCREEN_LINES });
    if (!showsTrustDialog(screen)) {
      if (!fresh) return agent;
      throw new DispatchError(
        "agent_blocked",
        `el agente ${name} arrancó bloqueado: ${screen.slice(-300)}`,
      );
    }
    await this.herdr.sendKeys({ name, keys: [...TRUST_ACCEPT_KEYS] });
    return this.herdr.waitAgent({ name, until: ["idle", "done"], timeoutMs: this.trustTimeoutMs });
  }

  private async resolveSession(run: RunRow) {
    if (run.agentSessionSource === "native") return undefined;
    const agent = run.herdrName
      ? await this.herdr.getAgent(run.herdrName).catch(() => undefined)
      : undefined;
    return resolveSession({ herdr: agent?.session, agentName: run.herdrName ?? run.id });
  }

  /**
   * Cierra el pane del Run (con él, su agente) y avisa al observador. Solo si el pane sigue siendo
   * del Run: tiene su agente, o está vacío en su workspace y en el worktree de la tarea.
   */
  private async release(runId: string): Promise<void> {
    this.observer?.unwatch(runId);
    const run = this.runs.get(runId);
    if (!run?.herdrPane) return;
    const snap = await this.herdr.snapshot();
    const pane = snap.panes.find((p) => p.paneId === run.herdrPane);
    if (!pane) return;
    const agent = snap.agents.find((a) => a.paneId === pane.paneId);
    const ours = agent
      ? agent.name === run.herdrName
      : pane.workspaceId === run.herdrWorkspace &&
        pane.cwd === (this.tasks.get(run.taskId)?.worktreePath ?? null);
    if (ours) await this.herdr.closePane(pane.paneId);
  }
}

/** El Run se cerró mientras se lanzaba: el lanzamiento se detiene sin fallarlo. */
class RunClosed extends Error {}

function requireName(run: RunRow): string {
  if (!run.herdrName) throw new DispatchError("run_not_found", `el Run ${run.id} no tiene nombre`);
  return run.herdrName;
}

/** `failure_reason` legible: código del error y su mensaje. */
function failureReason(error: unknown): string {
  const err = asError(error);
  const code =
    isDispatchError(err) || isWorktreeError(err) || isHerdrError(err)
      ? (err as { code: string }).code
      : "launch_failed";
  return `${code}: ${err.message}`.slice(0, 2_000);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultError(error: Error, runId: string | null): void {
  console.error(`[dispatcher] fallo en ${runId ? `Run ${runId}` : "recover"}: ${error.message}`);
}
