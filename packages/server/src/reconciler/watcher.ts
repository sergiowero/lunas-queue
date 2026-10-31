// Observación de los agentes vivos (docs/design.md §Señales y §Timeout de fase, ADR
// uw-17-reconciliacion). Implementa el `RunObserver` del dispatcher: por cada Run lanzado escucha
// el estado de su pane en herdr y su ciclo de vida, y aplica la tabla de señales:
// - `blocked` pausa el timeout y, si sigue así 1 minuto, notifica (Escalator, ADR 0009);
// - `idle`/`done` sin la señal MCP de fin de fase: nudge N veces y luego Run fallido;
// - pane cerrado o proceso terminado: Run fallido (reintento con backoff o needs_human);
// - timeout de fase vencido: needs_human con notificación; el agente sigue vivo.
// La base es la verdad: antes de actuar se relee el Run y la tarea, así una señal que llega tarde
// (el Run ya lo cerró una tool del MCP) no hace nada.
import type {
  AgentStatus,
  HerdrAdapter,
  HerdrAgent,
  HerdrEvent,
  HerdrSubscription,
} from "@lunasq/adapters";
import { showsUsageLimit, usageLimitMessage } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  ProjectRepository,
  RunRepository,
  type RunRow,
  TaskRepository,
  transitionTask,
} from "@lunasq/db";
import {
  nudgePrompt,
  type ProjectConfigReader,
  pendingPhase,
  phaseTimeoutMs,
} from "@lunasq/domain";
import {
  type BlockedAgent,
  type Notification,
  type OutboxMessage,
  type SchedulablePhase,
  SchedulablePhase as SchedulablePhaseSchema,
  TaskTransitionedPayload,
} from "@lunasq/schemas";
import type { RunObserver } from "../dispatcher/dispatcher.ts";
import type { Escalator } from "../notifications/escalator.ts";
import { KeyedLock } from "../worktrees/keyed-lock.ts";
import { PhaseClock } from "./phase-clock.ts";

/** Nudges antes de dar el Run por fallido (docs/design.md §Señales: "N veces"). */
export const DEFAULT_MAX_NUDGES = 2;
/**
 * Cuánto esperar con el agente detenido antes del nudge. Cubre la tool de salida que cierra el
 * Run justo antes de que el agente termine su turno.
 */
export const DEFAULT_NUDGE_GRACE_MS = 15_000;
/** Líneas que se lee del agente para reconocer la pantalla (la TUI dibuja el aviso abajo). */
const SCREEN_LINES = 40;

export interface RunWatcherOptions {
  db: LunasqDatabase;
  herdr: HerdrAdapter;
  /** `PhaseDispatcher.failRun`: cierra el Run, aplica `run_failed` y cierra el pane. */
  failRun: (runId: string, reason: string) => Promise<unknown>;
  escalator: Pick<Escalator, "watch" | "resolve">;
  notify: (notification: Notification) => unknown;
  projects?: ProjectConfigReader;
  /** Se perdieron eventos de herdr: quien reconcilia compara con el snapshot. */
  onLost?: () => void;
  maxNudges?: number;
  nudgeGraceMs?: number;
  onError?: (error: Error, runId: string | null) => void;
}

type Watch = {
  runId: string;
  taskId: string;
  phase: SchedulablePhase;
  name: string;
  paneId: string;
  sub: HerdrSubscription;
  clock: PhaseClock;
  status: AgentStatus;
  nudges: number;
  /** Veces que el agente quedó `blocked`: arma el id de cada notificación (ADR 0009). */
  blocks: number;
  blockedId: string | undefined;
  blockedSince: Date | undefined;
  grace: ReturnType<typeof setTimeout> | undefined;
  /** El timeout ya escaló: no hay más nudges ni timeout, solo se vigila que el pane siga vivo. */
  expired: boolean;
};

export class RunWatcher implements RunObserver {
  private readonly db: LunasqDatabase;
  private readonly herdr: HerdrAdapter;
  private readonly failRunFn: (runId: string, reason: string) => Promise<unknown>;
  private readonly escalator: Pick<Escalator, "watch" | "resolve">;
  private readonly notifyFn: (notification: Notification) => unknown;
  private readonly projects: ProjectConfigReader;
  private readonly onLost: () => void;
  private readonly maxNudges: number;
  private readonly nudgeGraceMs: number;
  private readonly onError: (error: Error, runId: string | null) => void;
  private readonly runs: RunRepository;
  private readonly tasks: TaskRepository;
  private readonly watches = new Map<string, Watch>();
  /** Señales de un mismo Run en orden: cada una relee la base antes de actuar. */
  private readonly locks = new KeyedLock();
  private lifecycle: HerdrSubscription | undefined;

  constructor(opts: RunWatcherOptions) {
    this.db = opts.db;
    this.herdr = opts.herdr;
    this.failRunFn = opts.failRun;
    this.escalator = opts.escalator;
    this.notifyFn = opts.notify;
    this.projects = opts.projects ?? new ProjectRepository(opts.db);
    this.onLost = opts.onLost ?? (() => {});
    this.maxNudges = opts.maxNudges ?? DEFAULT_MAX_NUDGES;
    this.nudgeGraceMs = opts.nudgeGraceMs ?? DEFAULT_NUDGE_GRACE_MS;
    this.onError = opts.onError ?? defaultError;
    this.runs = new RunRepository(opts.db);
    this.tasks = new TaskRepository(opts.db);
  }

  /** Empieza a observar un Run lanzado. Repetirlo con un Run ya observado no hace nada. */
  watch(run: RunRow, agent: HerdrAgent): void {
    if (this.watches.has(run.id) || run.endedAt !== null) return;
    const task = this.tasks.get(run.taskId);
    const project = task ? this.projects.get(task.projectId) : null;
    const phase = SchedulablePhaseSchema.safeParse(run.phase);
    if (!task || !project || !phase.success || !run.herdrName) {
      this.onError(new Error(`no se puede observar el Run ${run.id}`), run.id);
      return;
    }
    this.ensureLifecycle();
    const runId = run.id;
    const w: Watch = {
      runId,
      taskId: run.taskId,
      phase: phase.data,
      name: run.herdrName,
      paneId: agent.paneId,
      sub: this.herdr.subscribe({ paneIds: [agent.paneId] }, (event) =>
        this.onPaneEvent(runId, event),
      ),
      clock: new PhaseClock(phaseTimeoutMs(project, phase.data), () =>
        this.serial(runId, (w) => this.expire(w)),
      ),
      status: agent.status,
      nudges: 0,
      blocks: 0,
      blockedId: undefined,
      blockedSince: undefined,
      grace: undefined,
      expired: false,
    };
    this.watches.set(runId, w);
    if (task.subState === "waiting_human") w.clock.pause("waiting_human");
    w.clock.start();
    this.applyStatus(w, agent.status);
  }

  /** Deja de observar el Run: lo llama el dispatcher antes de cerrar su pane. Idempotente. */
  unwatch(runId: string): void {
    const w = this.watches.get(runId);
    if (!w) return;
    this.watches.delete(runId);
    w.clock.stop();
    clearTimeout(w.grace);
    if (w.blockedId) this.escalator.resolve(w.blockedId);
    w.sub.close().catch((e: unknown) => this.onError(asError(e), runId));
  }

  /**
   * Agentes que esperan un permiso en su TUI (herdr `blocked`): se responden en herdr, en el pane
   * del agente. Es lo que la bandeja muestra como "agente bloqueado".
   */
  blocked(): BlockedAgent[] {
    return [...this.watches.values()].flatMap((w) =>
      w.blockedSince
        ? [
            {
              runId: w.runId,
              taskId: w.taskId,
              phase: w.phase,
              agentName: w.name,
              paneId: w.paneId,
              since: w.blockedSince.toISOString(),
            },
          ]
        : [],
    );
  }

  /** Runs observados. */
  watching(): string[] {
    return [...this.watches.keys()];
  }

  /**
   * Transición de una tarea (outbox): `waiting_human` pausa el timeout y la respuesta lo retoma.
   * Si la tarea sale de running por otra vía (timeout, cancelación), no hay más nudges ni timeout.
   */
  onTransition(message: OutboxMessage): void {
    const payload = TaskTransitionedPayload.safeParse(message.payload);
    if (!payload.success) return;
    for (const w of this.watches.values()) {
      if (w.taskId !== message.taskId) continue;
      void this.serial(w.runId, async (w) => this.syncTask(w));
    }
  }

  async stop(): Promise<void> {
    for (const runId of [...this.watches.keys()]) this.unwatch(runId);
    const lifecycle = this.lifecycle;
    this.lifecycle = undefined;
    await lifecycle?.close();
  }

  // --- Señales ---

  private ensureLifecycle(): void {
    this.lifecycle ??= this.herdr.subscribe({ lifecycle: true }, (event) => {
      if (event.type === "events_lost") this.onLost();
      if (event.type !== "pane_closed" && event.type !== "pane_exited") return;
      for (const w of this.watches.values()) {
        if (w.paneId === event.paneId) {
          void this.serial(w.runId, (w) => this.gone(w, event.type === "pane_exited"));
        }
      }
    });
  }

  private onPaneEvent(runId: string, event: HerdrEvent): void {
    switch (event.type) {
      case "agent_status_changed":
        void this.serial(runId, async (w) => this.applyStatus(w, event.status));
        return;
      case "events_lost":
        // Pudo cambiar de estado sin que llegara el evento: se relee al reconectar.
        this.onLost();
        return;
      case "subscribed":
        void this.serial(runId, async (w) => {
          const agent = await this.herdr.getAgent(w.name);
          if (!this.current(w)) return;
          if (!agent) return this.gone(w, true);
          this.applyStatus(w, agent.status);
        });
        return;
      case "subscription_failed":
        // Solo `pane_not_found` dice que el pane ya no existe; otro error (protocolo, herdr
        // reiniciando) lo decide la reconciliación con el snapshot.
        if (event.code === "pane_not_found") void this.serial(runId, (w) => this.gone(w, false));
        else this.onLost();
        return;
      default:
        return;
    }
  }

  private applyStatus(w: Watch, status: AgentStatus): void {
    w.status = status;
    if (status !== "blocked" && w.blockedId) {
      this.escalator.resolve(w.blockedId);
      w.blockedId = undefined;
      w.blockedSince = undefined;
      w.clock.resume("blocked");
    }
    if (status === "blocked") {
      clearTimeout(w.grace);
      w.grace = undefined;
      if (!w.blockedId) {
        w.blocks += 1;
        w.blockedId = `blocked:${w.runId}:${w.blocks}`;
        w.blockedSince = new Date();
        w.clock.pause("blocked");
        this.escalator.watch({
          id: w.blockedId,
          kind: "agent_blocked",
          taskId: w.taskId,
          runId: w.runId,
          title: `Agente bloqueado en ${w.taskId.slice(0, 8)}`,
          body: `El agente ${w.name} (${w.phase}) espera un permiso en herdr desde hace 1 minuto.`,
        });
        // El bloqueo puede ser el límite de uso en forma de menú, no un permiso: se lee la
        // pantalla antes de que el aviso de bloqueado madure (1 minuto).
        void this.serial(w.runId, (w) => this.checkBlocked(w));
      }
    } else if (status === "idle" || status === "done") {
      if (w.grace === undefined && !w.expired) {
        w.grace = setTimeout(() => {
          w.grace = undefined;
          void this.serial(w.runId, (w) => this.stalled(w));
        }, this.nudgeGraceMs);
      }
    } else {
      clearTimeout(w.grace);
      w.grace = undefined;
    }
  }

  /**
   * Run que el watcher ya no debe fallar ni escalar: cerrado (una tool de salida lo cerró y el
   * dispatcher libera el pane al ver la transición) o con handoff guardado (el verificador dio
   * pass y la entrega corre con el Run abierto, ADR 0007).
   */
  private settled(w: Watch): boolean {
    const run = this.runs.get(w.runId);
    return !run || run.endedAt !== null || run.handoff !== null;
  }

  /** El Watch sigue siendo el vigente: tras un await el dispatcher pudo llamar `unwatch`. */
  private current(w: Watch): boolean {
    return this.watches.get(w.runId) === w;
  }

  /** El agente sigue detenido sin señal MCP pasada la gracia: nudge o Run fallido. */
  private async stalled(w: Watch): Promise<void> {
    if (w.expired || (w.status !== "idle" && w.status !== "done")) return;
    if (this.settled(w) || !this.inPhase(w, "running")) return;
    const agent = await this.herdr.getAgent(w.name);
    if (!this.current(w)) return;
    if (!agent) return this.gone(w, true);
    if (agent.status !== "idle" && agent.status !== "done")
      return this.applyStatus(w, agent.status);
    if (await this.usageLimit(w)) return;
    if (w.nudges < this.maxNudges) {
      w.nudges += 1;
      const prompted = await this.herdr.promptAgent({
        name: w.name,
        text: nudgePrompt(w.phase, w.taskId),
      });
      if (this.current(w)) this.applyStatus(w, prompted.status);
      return;
    }
    this.unwatch(w.runId);
    await this.failRunFn(
      w.runId,
      `agent_stopped: el agente ${w.name} se detuvo sin la señal de fin de fase tras ${w.nudges} nudges`,
    );
  }

  /** Al entrar en `blocked`: si la pantalla es el límite de uso (no un permiso), escala ahora. */
  private async checkBlocked(w: Watch): Promise<void> {
    if (w.expired || w.status !== "blocked" || this.settled(w)) return;
    await this.usageLimit(w);
  }

  /**
   * El aviso de límite de uso de Claude solo se ve en su pantalla (herdr no lo detecta, ADR 0004):
   * si está, pausa la tarea en needs_human hasta que alguien la reanude, con el Run y el agente
   * vivos, como el timeout de fase. Devuelve true si detectó y escaló.
   */
  private async usageLimit(w: Watch): Promise<boolean> {
    let screen: string;
    try {
      screen = await this.herdr.readAgent({ name: w.name, lines: SCREEN_LINES });
    } catch {
      return false; // el agente ya no responde: la señal siguiente (crash) decide la ruta.
    }
    if (!this.current(w) || !showsUsageLimit(screen)) return false;
    await this.escalateUsageLimit(w, usageLimitMessage(screen));
    return true;
  }

  /** needs_human con `usage_limit` y notificación; desde ese momento solo se vigila el pane. */
  private async escalateUsageLimit(w: Watch, message: string): Promise<void> {
    const task = this.tasks.get(w.taskId);
    if (!task || this.settled(w) || !this.inPhase(w, "running")) return;
    w.expired = true;
    clearTimeout(w.grace);
    w.grace = undefined;
    if (w.blockedId) this.escalator.resolve(w.blockedId);
    w.blockedId = undefined;
    w.blockedSince = undefined;
    const moved = transitionTask(this.db, {
      taskId: w.taskId,
      actor: "system",
      command: {
        type: "escalate",
        reason: "usage_limit",
        note: `El agente ${w.name} (${w.phase}) se quedó sin uso: ${message}`,
      },
      expected: { state: task.state, subState: "running" },
    });
    if (!moved.ok) return;
    await this.notifyFn({
      id: `usage:${w.runId}`,
      kind: "usage_limit",
      taskId: w.taskId,
      runId: w.runId,
      title: `Límite de uso en ${w.taskId.slice(0, 8)}`,
      body: `El agente ${w.name} (${w.phase}) llegó a su límite de uso ("${message}"). La tarea espera en needs_human: reanúdala cuando el límite se restablezca.`,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * El pane se cerró o el agente salió: Run fallido si sigue abierto. En waiting_human el Run se
   * deja abierto: ocupa su slot a propósito (ADR 0014) y la respuesta relanza (UW-22).
   */
  private async gone(w: Watch, exited: boolean): Promise<void> {
    this.unwatch(w.runId);
    if (this.settled(w) || this.inPhase(w, "waiting_human")) return;
    const what = exited ? "el proceso del agente terminó" : "el pane se cerró";
    await this.failRunFn(w.runId, `agent_exited: ${what} (${w.name}, pane ${w.paneId})`);
  }

  /** Timeout de fase vencido: needs_human con notificación; el agente sigue vivo. */
  private async expire(w: Watch): Promise<void> {
    if (this.inPhase(w, "waiting_human")) {
      // Venció con la pregunta abierta antes de que el outbox pausara el reloj: queda en pausa
      // sin presupuesto y vence en cuanto la respuesta lo reanude.
      w.clock = new PhaseClock(0, () => this.serial(w.runId, (w) => this.expire(w)));
      w.clock.pause("waiting_human");
      w.clock.start();
      return;
    }
    w.expired = true;
    clearTimeout(w.grace);
    w.grace = undefined;
    const task = this.tasks.get(w.taskId);
    if (!task || this.settled(w) || !this.inPhase(w, "running")) return;
    const project = this.projects.get(task.projectId);
    const minutes = project ? phaseTimeoutMs(project, w.phase) / 60_000 : undefined;
    const moved = transitionTask(this.db, {
      taskId: w.taskId,
      actor: "system",
      command: {
        type: "escalate",
        reason: "phase_timeout",
        note: `La fase ${w.phase} superó su timeout${minutes ? ` de ${minutes} min` : ""}; el agente ${w.name} sigue vivo en herdr.`,
      },
      expected: { state: task.state, subState: "running" },
    });
    if (!moved.ok) return;
    await this.notifyFn({
      id: `timeout:${w.runId}`,
      kind: "phase_timeout",
      taskId: w.taskId,
      runId: w.runId,
      title: `Timeout de fase en ${w.taskId.slice(0, 8)}`,
      body: `La fase ${w.phase} superó su timeout${minutes ? ` de ${minutes} min` : ""}. El agente ${w.name} sigue vivo: espera, intervén en herdr o cancela.`,
      createdAt: new Date().toISOString(),
    });
  }

  /** Alinea el reloj con el sub-estado de la tarea. */
  private syncTask(w: Watch): void {
    const task = this.tasks.get(w.taskId);
    if (task && pendingPhase(task.state) === w.phase && task.subState === "waiting_human") {
      w.clock.pause("waiting_human");
      clearTimeout(w.grace);
      w.grace = undefined;
      return;
    }
    if (this.inPhase(w, "running")) {
      w.clock.resume("waiting_human");
      // Tras una respuesta el agente puede seguir detenido: vuelve a contar la gracia.
      this.applyStatus(w, w.status);
      return;
    }
    // Salió de la fase (timeout, cancelación, needs_human): solo se vigila el pane.
    w.expired = true;
    w.clock.stop();
    clearTimeout(w.grace);
    w.grace = undefined;
  }

  private inPhase(w: Watch, subState: "running" | "waiting_human"): boolean {
    const task = this.tasks.get(w.taskId);
    return task !== null && pendingPhase(task.state) === w.phase && task.subState === subState;
  }

  /** Corre `fn` en orden con las demás señales del Run, si sigue observado. */
  private serial(runId: string, fn: (w: Watch) => Promise<void> | void): Promise<void> {
    return this.locks
      .run(runId, async () => {
        const w = this.watches.get(runId);
        if (w) await fn(w);
      })
      .catch((error: unknown) => this.onError(asError(error), runId));
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultError(error: Error, runId: string | null): void {
  console.error(`[watcher] fallo en ${runId ? `Run ${runId}` : "observación"}: ${error.message}`);
}
