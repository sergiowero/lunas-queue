// Runs: el claim atómico del dispatcher, el ciclo de vida de cada intento de un agente y lo que
// usa el LunasQ MCP (Questions, checklist). Las funciones sueltas aceptan la base o una
// transacción abierta, para que la tool de salida cierre el Run en la misma transacción que la
// transición de la tarea (ADR uw-15-mcp-tools, ADR uw-16-dispatcher, ADR 0007, ADR 0014).
import { randomBytes } from "node:crypto";
import {
  agentName,
  Occupancy,
  type ProjectConfigReader,
  pendingPhase,
  phaseProfile,
  type SessionIdentity,
} from "@lunasq/domain";
import {
  CHECKLIST_UPDATED,
  type ChecklistItem,
  ChecklistUpdatedPayload,
  type Phase,
  QUESTION_CREATED,
  QuestionCreatedPayload,
  type RunResult,
  type SchedulablePhase,
  type SchedulerConfig,
  type StatePosition,
  TASK_TRANSITIONED,
  VERDICT_RECORDED,
  VerdictRecordedPayload,
} from "@lunasq/schemas";
import { and, asc, count, desc, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import { SchedulerStateRepository } from "./scheduler-state.ts";
import { events, questions, runs, tasks } from "./schema.ts";
import { applyTransition, type TaskRow } from "./task-transitions.ts";

export type RunRow = typeof runs.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;

type Reader = Pick<LunasqDatabase, "select">;
type Writer = Pick<LunasqDatabase, "select" | "insert" | "update" | "transaction">;

/** Lo que el claim necesita de la decisión del scheduler (DispatchDecision sin score). */
export type ClaimDecision = {
  taskId: string;
  projectId: string;
  phase: SchedulablePhase;
  expected: StatePosition;
};

export type ClaimInput = {
  decision: ClaimDecision;
  config: SchedulerConfig;
  projects: ProjectConfigReader;
  /** Session id nativo que el dispatcher pasará a Claude Code (`--session-id`). */
  sessionId: string;
};

export type ClaimErrorCode =
  | "task_not_found"
  | "project_not_found"
  | "phase_mismatch"
  | "stale_state"
  | "no_slot"
  | "run_active"
  | "invalid_transition"
  | "actor_not_allowed"
  | "guard_failed"
  | "no_escalation_found";

export type ClaimResult =
  | { ok: true; run: RunRow; task: TaskRow }
  | { ok: false; error: { code: ClaimErrorCode; message: string } };

class ClaimRejected extends Error {
  readonly code: ClaimErrorCode;

  constructor(code: ClaimErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 256 bits: el token solo vive en el entorno del pane (ADR 0002). */
const newRunToken = () => randomBytes(32).toString("hex");

/**
 * Reclama la tarea para una fase: en una sola transacción IMMEDIATE revalida los límites con un
 * snapshot fresco (el plan del scheduler se calculó antes), aplica `dispatch` con `expected` y
 * crea el Run con su token. Si algo no cuadra no escribe nada. Repetirlo con la misma decisión
 * da `stale_state`: la tarea ya está en running.
 */
export function claimRun(db: LunasqDatabase, input: ClaimInput): ClaimResult {
  const { decision } = input;
  try {
    return db.transaction(
      (tx) => {
        const task = tx.select().from(tasks).where(eq(tasks.id, decision.taskId)).get();
        if (!task)
          throw new ClaimRejected("task_not_found", `no existe la tarea ${decision.taskId}`);
        const { expected } = decision;
        // Primero: repetir un claim ya aplicado es stale_state, no un Run activo.
        if (expected.state !== task.state || expected.subState !== task.subState) {
          throw new ClaimRejected(
            "stale_state",
            `se esperaba ${expected.state}/${expected.subState ?? "-"} y la tarea está en ${task.state}/${task.subState ?? "-"}`,
          );
        }
        if (pendingPhase(task.state) !== decision.phase) {
          throw new ClaimRejected(
            "phase_mismatch",
            `la tarea ${task.id} está en ${task.state}, no en una fase ${decision.phase}`,
          );
        }
        const project = input.projects.get(task.projectId);
        if (!project) {
          throw new ClaimRejected("project_not_found", `no existe el proyecto ${task.projectId}`);
        }
        const active = tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.taskId, task.id), isNull(runs.endedAt)))
          .get();
        if (active) {
          throw new ClaimRejected(
            "run_active",
            `la tarea ${task.id} tiene abierto el Run ${active.id}`,
          );
        }
        // La misma conexión: el snapshot ve lo que esta transacción ve (savepoint anidado).
        const occupancy = Occupancy.of(new SchedulerStateRepository(tx).snapshot(), input.projects);
        if (!occupancy.fits(occupancy.slotFor(task, decision.phase), input.config)) {
          throw new ClaimRejected("no_slot", `sin slot para ${task.id} en ${decision.phase}`);
        }

        const moved = applyTransition(tx, {
          taskId: task.id,
          actor: "system",
          command: { type: "dispatch" },
          expected: decision.expected,
        });
        if (!moved.ok) throw new ClaimRejected(moved.error.code, moved.error.message);

        const [{ previous } = { previous: 0 }] = tx
          .select({ previous: count() })
          .from(runs)
          .where(and(eq(runs.taskId, task.id), eq(runs.phase, decision.phase)))
          .all();
        const profile = phaseProfile(project, decision.phase);
        const [run] = tx
          .insert(runs)
          .values({
            taskId: task.id,
            phase: decision.phase,
            agentKind: profile.kind,
            model: profile.model ?? null,
            iteration: task.verificationIteration,
            herdrName: agentName(task.id, decision.phase, previous + 1),
            agentSession: input.sessionId,
            agentSessionSource: "native",
            runToken: newRunToken(),
          })
          .returning()
          .all();
        if (!run) throw new Error("insert de run sin fila");
        return { ok: true as const, run, task: moved.task };
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (error instanceof ClaimRejected) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    throw error;
  }
}

export class RunRepository {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  get(runId: string): RunRow | null {
    return this.db.select().from(runs).where(eq(runs.id, runId)).get() ?? null;
  }

  /** El Run activo (sin ended_at) con ese token; un token de un Run cerrado no cuenta. */
  activeByToken(token: string): RunRow | null {
    return (
      this.db
        .select()
        .from(runs)
        .where(and(eq(runs.runToken, token), isNull(runs.endedAt)))
        .get() ?? null
    );
  }

  /**
   * El Run con ese token, esté o no cerrado. La telemetría llega con retraso (Claude Code vacía su
   * buffer al salir), así que el usage collector acepta también el último lote de un Run cerrado.
   */
  byToken(token: string): RunRow | null {
    return this.db.select().from(runs).where(eq(runs.runToken, token)).get() ?? null;
  }

  /** Registra la primera lectura del contexto; repetir devuelve la misma fecha. */
  markContextRead(runId: string, at = new Date()): Date | null {
    this.db
      .update(runs)
      .set({ contextReadAt: at })
      .where(and(eq(runs.id, runId), isNull(runs.contextReadAt)))
      .run();
    return this.get(runId)?.contextReadAt ?? null;
  }

  /** Guarda el handoff sin cerrar el Run: el verificador con pass sigue abierto (ADR 0007). */
  recordHandoff(runId: string, handoff: unknown): void {
    this.db.update(runs).set({ handoff }).where(eq(runs.id, runId)).run();
  }

  /** Handoffs guardados de la fase, del Run más viejo al más nuevo. */
  handoffs(taskId: string, phase: Phase): unknown[] {
    return this.db
      .select({ handoff: runs.handoff })
      .from(runs)
      .where(and(eq(runs.taskId, taskId), eq(runs.phase, phase), isNotNull(runs.handoff)))
      .orderBy(asc(runs.startedAt))
      .all()
      .map((r) => r.handoff);
  }

  /** El Run más nuevo de la fase con handoff guardado, con su iteración; null si no hay. */
  latestHandoff(
    taskId: string,
    phase: Phase,
  ): { runId: string; iteration: number; handoff: unknown } | null {
    return (
      this.db
        .select({ runId: runs.id, iteration: runs.iteration, handoff: runs.handoff })
        .from(runs)
        .where(and(eq(runs.taskId, taskId), eq(runs.phase, phase), isNotNull(runs.handoff)))
        .orderBy(desc(runs.startedAt), desc(sql`rowid`))
        .limit(1)
        .get() ?? null
    );
  }

  /** El último Run cerrado de la fase, sin contar `exceptRunId`: el intento anterior. */
  previousRun(taskId: string, phase: Phase, exceptRunId: string): RunRow | null {
    return (
      this.db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.taskId, taskId),
            eq(runs.phase, phase),
            ne(runs.id, exceptRunId),
            isNotNull(runs.endedAt),
          ),
        )
        .orderBy(desc(runs.startedAt))
        .limit(1)
        .get() ?? null
    );
  }

  /** Runs de la tarea en orden de creación. */
  forTask(taskId: string): RunRow[] {
    return this.db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(sql`rowid`).all();
  }

  /** Runs abiertos (sin ended_at): los que pueden tener un agente vivo. */
  active(): RunRow[] {
    return this.db.select().from(runs).where(isNull(runs.endedAt)).orderBy(sql`rowid`).all();
  }

  /** El Run más reciente de la tarea, abierto o no. */
  latestForTask(taskId: string): RunRow | null {
    return (
      this.db
        .select()
        .from(runs)
        .where(eq(runs.taskId, taskId))
        .orderBy(sql`rowid desc`)
        .limit(1)
        .get() ?? null
    );
  }

  recordPane(runId: string, pane: { workspaceId: string; paneId: string }): void {
    this.db
      .update(runs)
      .set({ herdrWorkspace: pane.workspaceId, herdrPane: pane.paneId })
      .where(eq(runs.id, runId))
      .run();
  }

  /** Marca que el prompt de fase salió; conserva la primera marca. */
  markLaunched(runId: string): RunRow | null {
    this.db
      .update(runs)
      .set({ launchedAt: new Date() })
      .where(and(eq(runs.id, runId), isNull(runs.launchedAt)))
      .run();
    return this.get(runId);
  }

  /** Cierra el Run una sola vez: si ya estaba cerrado no cambia nada y devuelve closed false. */
  close(runId: string, input: CloseRunInput): { closed: boolean; run: RunRow | null } {
    const closed = closeRun(this.db, runId, input);
    return { closed, run: this.get(runId) };
  }

  /**
   * Run fallido que no declaró el agente (crash, despacho que no llegó a lanzar): lo cierra como
   * failure y, si la tarea sigue en running en la fase del Run, aplica `run_failed` con el mismo
   * conteo que `report_failure`. Al agotar los reintentos la tarea pasa a needs_human (ADR 0007).
   */
  fail(runId: string, reason: string, opts: { maxRetries?: number } = {}): FailRunResult {
    return this.db.transaction(
      (tx) => {
        const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
        if (!run) throw new Error(`no existe el Run ${runId}`);
        // Antes de cerrar: los fallos previos, más este.
        const attempt = consecutiveFailures(tx, run.taskId, run.phase) + 1;
        if (!closeRun(tx, runId, { result: "failure", failureReason: reason })) {
          return { closed: false, transitioned: false };
        }
        const task = tx.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
        if (task?.subState !== "running" || pendingPhase(task.state) !== run.phase) {
          return { closed: true, transitioned: false };
        }
        const moved = applyTransition(tx, {
          taskId: task.id,
          actor: "system",
          command: {
            type: "run_failed",
            attempt,
            ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
          },
          expected: { state: task.state, subState: "running" },
        });
        if (!moved.ok) throw new Error(`run_failed de ${task.id}: ${moved.error.message}`);
        return { closed: true, transitioned: true, task: moved.task };
      },
      { behavior: "immediate" },
    );
  }

  /** Runs fallidos seguidos de la fase, desde el último exitoso o el último resume (ADR 0007). */
  consecutiveFailures(taskId: string, phase: Phase): number {
    return consecutiveFailures(this.db, taskId, phase);
  }
}

export type CloseRunInput = {
  result: RunResult;
  failureReason?: string;
  handoff?: unknown;
  /** Identidad de sesión resuelta al cerrar; sin ella se conserva la del despacho. */
  session?: SessionIdentity;
};

export type FailRunResult = { closed: boolean; transitioned: boolean; task?: TaskRow };

/** Cierra el Run si sigue abierto; false si ya estaba cerrado. */
export function closeRun(
  db: Writer,
  runId: string,
  input: CloseRunInput,
  at = new Date(),
): boolean {
  const closed = db
    .update(runs)
    .set({
      endedAt: at,
      result: input.result,
      failureReason: input.failureReason ?? null,
      ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
      ...(input.session && {
        agentSession: input.session.value,
        agentSessionSource: input.session.source,
      }),
    })
    .where(and(eq(runs.id, runId), isNull(runs.endedAt)))
    .returning({ id: runs.id })
    .all();
  return closed.length > 0;
}

/**
 * Registra el veredicto del approver (ADR uw-23-verificacion): fija la etiqueta de riesgo de la
 * tarea y agrega `verification.verdict_recorded` al Event log y al outbox. Corre dentro de la
 * transacción de `submit_verdict`.
 */
export function recordVerdict(db: Writer, taskId: string, payload: VerdictRecordedPayload): void {
  const parsed = VerdictRecordedPayload.parse(payload);
  db.update(tasks).set({ riskLabel: parsed.riskLabel }).where(eq(tasks.id, taskId)).run();
  appendEvent(
    db,
    { taskId, type: VERDICT_RECORDED, actor: "agent", payload: parsed },
    { publish: true },
  );
}

/**
 * Runs fallidos seguidos de la fase, del más nuevo hacia atrás, hasta uno que no falló o hasta
 * el último resume de la tarea: es el `attempt` de run_failed sin contar el Run que falla ahora.
 */
export function consecutiveFailures(db: Reader, taskId: string, phase: Phase): number {
  const lastResume = db
    .select({ at: events.createdAt })
    .from(events)
    .where(
      and(
        eq(events.taskId, taskId),
        eq(events.type, TASK_TRANSITIONED),
        sql`json_extract(${events.payload}, '$.command') = 'resume'`,
      ),
    )
    .orderBy(desc(events.id))
    .limit(1)
    .get();
  const closed = db
    .select({ result: runs.result })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.phase, phase),
        isNotNull(runs.endedAt),
        lastResume ? gt(runs.startedAt, lastResume.at) : undefined,
      ),
    )
    // rowid desempata Runs del mismo milisegundo: es el orden de creación.
    .orderBy(desc(runs.startedAt), sql`rowid desc`)
    .all();
  const firstOther = closed.findIndex((r) => r.result !== "failure");
  return firstOther === -1 ? closed.length : firstOther;
}

export type CreateQuestionInput = {
  taskId: string;
  runId: string;
  question: string;
  context?: string;
};

export function createQuestion(db: Writer, input: CreateQuestionInput): QuestionRow {
  return db.transaction((tx) => {
    const [row] = tx
      .insert(questions)
      .values({
        taskId: input.taskId,
        runId: input.runId,
        question: input.question,
        context: input.context ?? null,
      })
      .returning()
      .all();
    if (!row) throw new Error("insert de question sin fila");
    const payload = QuestionCreatedPayload.parse({ questionId: row.id, runId: input.runId });
    appendEvent(tx, { taskId: input.taskId, type: QUESTION_CREATED, actor: "agent", payload });
    return row;
  });
}

export function listQuestions(db: Reader, taskId: string): QuestionRow[] {
  return db
    .select()
    .from(questions)
    .where(eq(questions.taskId, taskId))
    .orderBy(asc(questions.createdAt), asc(questions.id))
    .all();
}

/** Agrega el snapshot completo del checklist al Event log. */
export function appendChecklist(
  db: Writer,
  taskId: string,
  runId: string,
  items: ChecklistItem[],
): void {
  const payload = ChecklistUpdatedPayload.parse({ runId, items });
  appendEvent(db, { taskId, type: CHECKLIST_UPDATED, actor: "agent", payload });
}

export function latestChecklist(db: Reader, taskId: string): ChecklistItem[] | null {
  const row = db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.taskId, taskId), eq(events.type, CHECKLIST_UPDATED)))
    .orderBy(desc(events.id))
    .limit(1)
    .get();
  return row ? ChecklistUpdatedPayload.parse(row.payload).items : null;
}
