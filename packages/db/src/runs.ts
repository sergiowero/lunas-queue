// Runs: el claim atómico del dispatcher y el ciclo de vida de cada intento de un agente
// (docs/design.md §Secuencia de despacho, ADR 0007, ADR 0014, ADR uw-16-dispatcher).
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
  type RunResult,
  type SchedulablePhase,
  type SchedulerConfig,
  type StatePosition,
  TASK_TRANSITIONED,
} from "@lunasq/schemas";
import { and, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { SchedulerStateRepository } from "./scheduler-state.ts";
import { events, runs, tasks } from "./schema.ts";
import { applyTransition, type TaskRow, type Tx } from "./task-transitions.ts";

export type RunRow = typeof runs.$inferSelect;

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

export type CloseRunInput = {
  result: RunResult;
  handoff?: unknown;
  failureReason?: string;
  /** Identidad de sesión resuelta al cerrar; sin ella se conserva la del despacho. */
  session?: SessionIdentity;
};

export type FailRunResult = { closed: boolean; transitioned: boolean; task?: TaskRow };

export class RunRepository {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  get(runId: string): RunRow | undefined {
    return this.db.select().from(runs).where(eq(runs.id, runId)).get();
  }

  /** Runs de la tarea en orden de creación. */
  forTask(taskId: string): RunRow[] {
    return this.db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(sql`rowid`).all();
  }

  /** Runs abiertos (sin ended_at): los que pueden tener un agente vivo. */
  active(): RunRow[] {
    return this.db.select().from(runs).where(isNull(runs.endedAt)).orderBy(sql`rowid`).all();
  }

  /** El Run activo con ese token; un token de un Run cerrado ya no mueve nada. */
  activeByToken(runToken: string): RunRow | undefined {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.runToken, runToken), isNull(runs.endedAt)))
      .get();
  }

  recordPane(runId: string, pane: { workspaceId: string; paneId: string }): void {
    this.db
      .update(runs)
      .set({ herdrWorkspace: pane.workspaceId, herdrPane: pane.paneId })
      .where(eq(runs.id, runId))
      .run();
  }

  /** Marca que el prompt de fase salió; conserva la primera marca. */
  markLaunched(runId: string): RunRow | undefined {
    this.db
      .update(runs)
      .set({ launchedAt: new Date() })
      .where(and(eq(runs.id, runId), isNull(runs.launchedAt)))
      .run();
    return this.get(runId);
  }

  /** Cierra el Run una sola vez: si ya estaba cerrado no cambia nada y devuelve closed false. */
  close(runId: string, input: CloseRunInput): { closed: boolean; run: RunRow | undefined } {
    const closed = this.db.transaction((tx) => closeOpen(tx, runId, input));
    return { closed, run: this.get(runId) };
  }

  /**
   * Run fallido (crash, despacho que no llegó a lanzar, `report_failure`): lo cierra como failure
   * y, si la tarea sigue en running en la fase del Run, aplica `run_failed` con los fallos
   * consecutivos de la fase. Al agotar los reintentos la tarea pasa a needs_human (ADR 0007).
   */
  fail(runId: string, reason: string, opts: { maxRetries?: number } = {}): FailRunResult {
    return this.db.transaction(
      (tx) => {
        const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
        if (!run) throw new Error(`no existe el Run ${runId}`);
        if (!closeOpen(tx, runId, { result: "failure", failureReason: reason })) {
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
            // El Run que falla cuenta siempre, aunque empiece en el mismo ms que un resume.
            attempt: Math.max(1, failuresSince(tx, task.id, run.phase, run.id)),
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
  consecutiveFailures(taskId: string, phase: SchedulablePhase): number {
    return failuresSince(this.db, taskId, phase);
  }
}

type Reader = Pick<LunasqDatabase, "select">;

function closeOpen(tx: Tx, runId: string, input: CloseRunInput): boolean {
  const updated = tx
    .update(runs)
    .set({
      endedAt: new Date(),
      result: input.result,
      ...(input.handoff !== undefined && { handoff: input.handoff }),
      ...(input.failureReason !== undefined && { failureReason: input.failureReason }),
      ...(input.session && {
        agentSession: input.session.value,
        agentSessionSource: input.session.source,
      }),
    })
    .where(and(eq(runs.id, runId), isNull(runs.endedAt)))
    .returning({ id: runs.id })
    .all();
  return updated.length > 0;
}

function failuresSince(
  db: Reader,
  taskId: string,
  phase: SchedulablePhase,
  includeRunId?: string,
): number {
  const resumedAt = db
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
    .get()?.at;
  const recent = db
    .select({ result: runs.result })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.phase, phase),
        // Un Run del mismo milisegundo que el resume cuenta como anterior, salvo el que falla ahora.
        resumedAt
          ? includeRunId
            ? or(gt(runs.startedAt, resumedAt), eq(runs.id, includeRunId))
            : gt(runs.startedAt, resumedAt)
          : undefined,
      ),
    )
    .orderBy(sql`rowid desc`)
    .all();
  let failures = 0;
  for (const run of recent) {
    if (run.result === null) continue;
    if (run.result !== "failure") break;
    failures += 1;
  }
  return failures;
}
