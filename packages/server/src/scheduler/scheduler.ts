// Scheduler en proceso (docs/design.md §Scheduler, ADR 0014). Cada pasada lee un snapshot de la
// base, calcula el plan con @lunasq/domain, escala a los dependientes de dependencias que ya no
// se entregarán y entrega las decisiones al dispatcher una por una. Corre ante cada mensaje del
// outbox y en un tick periódico; como recalcula todo desde la base, repetir una pasada no
// duplica efectos.
import {
  type LunasqDatabase,
  ProjectRepository,
  SchedulerStateRepository,
  transitionTask,
} from "@lunasq/db";
import {
  type DependencyEscalation,
  type DispatchDecision,
  type ProjectConfigReader,
  type SchedulerStateReader,
  schedule,
} from "@lunasq/domain";
import { SchedulerConfig, type SchedulerConfigInput } from "@lunasq/schemas";
import type { OutboxPublisher } from "../outbox/publisher.ts";

/**
 * Puerto hacia el dispatcher (UW-16). `dispatch` resuelve cuando el claim quedó confirmado (la
 * tarea ya está en running) o rechaza si no se pudo; así la pasada siguiente ve el slot ocupado.
 * El claim debe volver a validar los límites: el plan se calculó antes.
 */
export interface Dispatcher {
  dispatch(decision: DispatchDecision): Promise<void>;
}

/** `failed` es la decisión o el escalamiento que falló, o null si falló la lectura. */
export type SchedulerErrorHandler = (
  error: Error,
  failed: DispatchDecision | DependencyEscalation | null,
) => void;

export interface SchedulerOptions {
  db: LunasqDatabase;
  dispatcher: Dispatcher;
  config?: SchedulerConfigInput;
  /** Se suscribe a todos sus topics y se despierta después de escalar. */
  publisher?: OutboxPublisher;
  state?: SchedulerStateReader;
  projects?: ProjectConfigReader;
  now?: () => Date;
  onError?: SchedulerErrorHandler;
}

export type SchedulerPassResult = { dispatched: string[]; escalated: string[] };

export class Scheduler {
  private readonly db: LunasqDatabase;
  private readonly dispatcher: Dispatcher;
  private readonly config: SchedulerConfig;
  private readonly publisher: OutboxPublisher | undefined;
  private readonly state: SchedulerStateReader;
  private readonly projects: ProjectConfigReader;
  private readonly now: () => Date;
  private readonly onError: SchedulerErrorHandler;
  private running: Promise<SchedulerPassResult> | undefined;
  // Pedido de otra pasada mientras corre una: lo que cambió después de su lectura.
  private rerun = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(opts: SchedulerOptions) {
    this.db = opts.db;
    this.dispatcher = opts.dispatcher;
    this.config = SchedulerConfig.parse(opts.config ?? {});
    this.publisher = opts.publisher;
    this.state = opts.state ?? new SchedulerStateRepository(opts.db);
    this.projects = opts.projects ?? new ProjectRepository(opts.db);
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError ?? defaultError;
  }

  /** Una pasada (o se une a la que corre y pide otra). Devuelve lo que hizo la última. */
  run(): Promise<SchedulerPassResult> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = Promise.resolve()
      .then(() => this.loop())
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** Pide una pasada sin esperarla. */
  wake(): void {
    this.run().catch((error: unknown) => this.report(toError(error), null));
  }

  /** Se suscribe al outbox, arranca el tick y hace una primera pasada. */
  async start(): Promise<void> {
    this.stopped = false;
    // El handler no espera la pasada: no frena al publicador y la pasada lee la base de todos modos.
    this.unsubscribe ??= this.publisher?.subscribe("*", () => this.wake());
    this.timer ??= setInterval(() => this.wake(), this.config.tickIntervalMs);
    await this.run().catch((error: unknown) => this.report(toError(error), null));
  }

  /** Detiene el tick y la suscripción y espera la pasada en curso, que no despacha más. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.running?.catch(() => {});
  }

  private async loop(): Promise<SchedulerPassResult> {
    let result: SchedulerPassResult = { dispatched: [], escalated: [] };
    do {
      this.rerun = false;
      if (this.stopped) break;
      result = await this.pass();
    } while (this.rerun);
    return result;
  }

  private async pass(): Promise<SchedulerPassResult> {
    const plan = schedule(this.state.snapshot(), this.projects, this.config, this.now());
    const escalated = plan.escalate.filter((e) => this.escalate(e));
    if (escalated.length > 0) this.publisher?.wake();

    const dispatched: string[] = [];
    for (const decision of plan.dispatch) {
      if (this.stopped) break;
      try {
        await this.dispatcher.dispatch(decision);
        dispatched.push(decision.taskId);
      } catch (error) {
        // Un claim perdido no detiene la pasada: las demás decisiones siguen siendo válidas.
        this.report(toError(error), decision);
      }
    }
    return { dispatched, escalated: escalated.map((e) => e.taskId) };
  }

  private escalate(escalation: DependencyEscalation): boolean {
    const result = transitionTask(this.db, {
      taskId: escalation.taskId,
      actor: "system",
      command: {
        type: "escalate",
        reason: "dependency_pr_closed",
        note: `la dependencia ${escalation.dependsOnId} ya no se entregará`,
      },
      expected: escalation.expected,
    });
    if (result.ok) return true;
    // stale_state: la tarea se movió después de la lectura; la siguiente pasada la reevalúa.
    if (result.error.code !== "stale_state") {
      this.report(new Error(`${result.error.code}: ${result.error.message}`), escalation);
    }
    return false;
  }

  private report(error: Error, failed: DispatchDecision | DependencyEscalation | null): void {
    try {
      this.onError(error, failed);
    } catch {
      // Un onError roto no detiene al scheduler.
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultError(error: Error, failed: DispatchDecision | DependencyEscalation | null): void {
  const where = failed ? `tarea ${failed.taskId}` : "lectura";
  console.error(`[scheduler] fallo en ${where}: ${error.message}`);
}
