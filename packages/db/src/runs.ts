// Runs: the dispatcher's atomic claim, the lifecycle of each agent attempt and what the
// LunasQ MCP uses (Questions, checklist). The standalone functions accept the database or an open
// transaction, so the exit tool closes the Run in the same transaction as the task
// transition (ADR uw-15-mcp-tools, ADR uw-16-dispatcher, ADR 0007, ADR 0014).
import { randomBytes } from "node:crypto";
import {
  agentName,
  Occupancy,
  type PhaseModel,
  type ProjectConfigReader,
  pendingPhase,
  resolveProjectPhase,
  type SessionIdentity,
} from "@lunasq/domain";
import {
  AgentKind,
  CHECKLIST_UPDATED,
  type ChecklistItem,
  ChecklistUpdatedPayload,
  type Phase,
  QUESTION_CREATED,
  QuestionCreatedPayload,
  type QuestionOptions,
  RUN_FAILED,
  RUN_MODEL_FALLBACK,
  RUN_PROVIDER_ATTEMPT,
  RunFailedPayload,
  RunModelFallbackPayload,
  type RunResult,
  SchedulablePhase,
  type SchedulerConfig,
  type StatePosition,
  TASK_TRANSITIONED,
  VERDICT_RECORDED,
  VerdictRecordedPayload,
} from "@lunasq/schemas";
import { and, asc, count, desc, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { readAgentProfile } from "./agent-profiles.ts";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import { SchedulerStateRepository } from "./scheduler-state.ts";
import { events, questions, runs, tasks } from "./schema.ts";
import { readConcurrencySettings, readProviderSettings } from "./settings.ts";
import { applyTransition, type TaskRow } from "./task-transitions.ts";

export type RunRow = typeof runs.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;

type Reader = Pick<LunasqDatabase, "select">;
type Writer = Pick<LunasqDatabase, "select" | "insert" | "update" | "transaction">;

/** What the claim needs from the scheduler's decision (DispatchDecision without score). */
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
  /** Native session id the dispatcher will pass to Claude Code (`--session-id`). */
  sessionId: string;
};

export type ClaimErrorCode =
  | "task_not_found"
  | "project_not_found"
  | "phase_mismatch"
  | "stale_state"
  | "no_slot"
  | "providers_disabled"
  | "profile_missing"
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

/** 256 bits: the token only lives in the pane's environment (ADR 0002). */
const newRunToken = () => randomBytes(32).toString("hex");

/**
 * The scheduler configuration with the global limit in force: the one saved in Settings or, with no
 * value, the one from `config`. It is read inside the claim transaction to revalidate against the latest.
 */
function effectiveConfig(
  db: Pick<LunasqDatabase, "select">,
  config: SchedulerConfig,
): SchedulerConfig {
  return {
    ...config,
    globalConcurrency: readConcurrencySettings(db, config.globalConcurrency).globalConcurrency,
  };
}

/**
 * Claims the task for a phase: in a single IMMEDIATE transaction it revalidates the limits with a fresh
 * snapshot (the scheduler plan was computed earlier) and against the currently enabled providers,
 * applies `dispatch` with `expected` and creates the Run with its token and the effective provider. If anything does not add up it writes nothing. Repeating it with the same decision
 * gives `stale_state`: the task is already running.
 */
export function claimRun(db: LunasqDatabase, input: ClaimInput): ClaimResult {
  const { decision } = input;
  try {
    return db.transaction(
      (tx) => {
        const task = tx.select().from(tasks).where(eq(tasks.id, decision.taskId)).get();
        if (!task)
          throw new ClaimRejected("task_not_found", `task ${decision.taskId} does not exist`);
        const { expected } = decision;
        // First: repeating an already applied claim is stale_state, not an active Run.
        if (expected.state !== task.state || expected.subState !== task.subState) {
          throw new ClaimRejected(
            "stale_state",
            `expected ${expected.state}/${expected.subState ?? "-"} but the task is in ${task.state}/${task.subState ?? "-"}`,
          );
        }
        if (pendingPhase(task.state) !== decision.phase) {
          throw new ClaimRejected(
            "phase_mismatch",
            `task ${task.id} is in ${task.state}, not in a ${decision.phase} phase`,
          );
        }
        const project = input.projects.get(task.projectId);
        if (!project) {
          throw new ClaimRejected("project_not_found", `project ${task.projectId} does not exist`);
        }
        const active = tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.taskId, task.id), isNull(runs.endedAt)))
          .get();
        if (active) {
          throw new ClaimRejected("run_active", `task ${task.id} has Run ${active.id} open`);
        }
        // Enabled providers and the profile are read here, not when planning: the human may have
        // changed them. The effective model is the first enabled one not yet exhausted in this phase dispatch.
        const providers = readProviderSettings(tx);
        const profiles = { get: (profileId: string) => readAgentProfile(tx, profileId) };
        const exhaustedModels = exhaustedModelIndexes(tx, task.id, decision.phase);
        const resolved = resolveProjectPhase(
          project,
          decision.phase,
          profiles,
          providers,
          exhaustedModels,
        );
        if (resolved.status === "unassigned") {
          throw new ClaimRejected(
            "profile_missing",
            `the ${decision.phase} phase of project ${project.name} has no agent profile`,
          );
        }
        if (resolved.status !== "ready") {
          throw new ClaimRejected(
            "providers_disabled",
            resolved.status === "exhausted"
              ? `every enabled model of the ${decision.phase} profile already failed for ${task.id}`
              : `no agent provider is enabled for ${task.id}`,
          );
        }
        // The same connection: the snapshot sees what this transaction sees (nested savepoint).
        const occupancy = Occupancy.of(
          new SchedulerStateRepository(tx).snapshot(),
          input.projects,
          profiles,
          providers,
        );
        // The global limit is also read here: Settings may have changed it after planning.
        const config = effectiveConfig(tx, input.config);
        if (
          !occupancy.fits(occupancy.slotFor({ ...task, exhaustedModels }, decision.phase), config)
        ) {
          throw new ClaimRejected("no_slot", `no slot for ${task.id} in ${decision.phase}`);
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
        const [run] = tx
          .insert(runs)
          .values({
            taskId: task.id,
            phase: decision.phase,
            agentKind: resolved.model.kind,
            model: resolved.model.model ?? null,
            profileId: resolved.profileId,
            modelIndex: resolved.index,
            iteration: task.verificationIteration,
            herdrName: agentName(task.id, decision.phase, previous + 1),
            agentSession: input.sessionId,
            agentSessionSource: "native",
            runToken: newRunToken(),
          })
          .returning()
          .all();
        if (!run) throw new Error("run insert without a row");
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

  /** The active Run (no ended_at) with that token; the token of a closed Run does not count. */
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
   * The Run with that token, closed or not. Telemetry arrives late (Claude Code flushes its
   * buffer on exit), so the usage collector also accepts the last batch of a closed Run.
   */
  byToken(token: string): RunRow | null {
    return this.db.select().from(runs).where(eq(runs.runToken, token)).get() ?? null;
  }

  /** Records the first context read; repeating it returns the same date. */
  markContextRead(runId: string, at = new Date()): Date | null {
    this.db
      .update(runs)
      .set({ contextReadAt: at })
      .where(and(eq(runs.id, runId), isNull(runs.contextReadAt)))
      .run();
    return this.get(runId)?.contextReadAt ?? null;
  }

  /** Saves the handoff without closing the Run: the verifier with pass stays open (ADR 0007). */
  recordHandoff(runId: string, handoff: unknown): void {
    this.db.update(runs).set({ handoff }).where(eq(runs.id, runId)).run();
  }

  /**
   * Delivery is running: the verifier's Run stays open with its pass saved (ADR 0007). Pausing
   * there would leave the PR half done.
   */
  deliveryInProgress(taskId: string): boolean {
    return (
      this.db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.taskId, taskId),
            eq(runs.phase, "verify"),
            isNull(runs.endedAt),
            isNotNull(runs.handoff),
          ),
        )
        .limit(1)
        .get() !== undefined
    );
  }

  /** Saved handoffs of the phase, from the oldest Run to the newest. */
  handoffs(taskId: string, phase: Phase): unknown[] {
    return this.db
      .select({ handoff: runs.handoff })
      .from(runs)
      .where(and(eq(runs.taskId, taskId), eq(runs.phase, phase), isNotNull(runs.handoff)))
      .orderBy(asc(runs.startedAt))
      .all()
      .map((r) => r.handoff);
  }

  /** The newest Run of the phase with a saved handoff, with its iteration; null if there is none. */
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

  /** The last closed Run of the phase, not counting `exceptRunId`: the previous attempt. */
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

  /** Runs of the task in creation order. */
  forTask(taskId: string): RunRow[] {
    return this.db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(sql`rowid`).all();
  }

  /** Open Runs (no ended_at): those that may have a live agent. */
  active(): RunRow[] {
    return this.db.select().from(runs).where(isNull(runs.endedAt)).orderBy(sql`rowid`).all();
  }

  /** The task's most recent Run, open or not. */
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

  clearPane(runId: string): void {
    this.db
      .update(runs)
      .set({ herdrWorkspace: null, herdrPane: null })
      .where(eq(runs.id, runId))
      .run();
  }

  /**
   * Moves the Run to another model of its profile. The claim reserved the slot of the provider of the
   * model effective back then; moving to a model of another provider (a fallback after the start failed,
   * or because Settings changed) revalidates it in the same transaction against the live agents of the
   * other Runs, with the same limits as the claim. Returns `no_slot` without writing anything if the new
   * provider does not fit; null if there is no Run.
   */
  switchModel(
    runId: string,
    target: PhaseModel,
    limits: { projects: ProjectConfigReader; config: SchedulerConfig },
  ): RunRow | "no_slot" | null {
    return this.db.transaction(
      (tx) => {
        const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
        if (!run) return null;
        if (run.agentKind !== target.model.kind) {
          const task = tx.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
          const snapshot = new SchedulerStateRepository(tx).snapshot();
          // Without the Run itself: it is placed again, not added to its current slot.
          const others = { ...snapshot, tasks: snapshot.tasks.filter((t) => t.id !== run.taskId) };
          const occupancy = Occupancy.of(
            others,
            limits.projects,
            { get: (profileId) => readAgentProfile(tx, profileId) },
            readProviderSettings(tx),
          );
          const slot = {
            projectId: task?.projectId ?? "",
            phase: SchedulablePhase.parse(run.phase),
            agentKind: target.model.kind,
          };
          if (!occupancy.fits(slot, effectiveConfig(tx, limits.config))) return "no_slot" as const;
        }
        tx.update(runs)
          .set({
            agentKind: target.model.kind,
            model: target.model.model ?? null,
            profileId: target.profileId,
            modelIndex: target.index,
          })
          .where(eq(runs.id, runId))
          .run();
        return tx.select().from(runs).where(eq(runs.id, runId)).get() ?? null;
      },
      { behavior: "immediate" },
    );
  }

  /** Start attempts of the Run's models, in order (run.provider_attempt events). */
  providerAttempts(runId: string): ProviderAttempt[] {
    const run = this.get(runId);
    if (!run) return [];
    return providerAttemptsOf(this.db, run.taskId, (id) => id === runId);
  }

  recordProviderAttempt(
    runId: string,
    attempt: { provider: AgentKind; modelIndex: number; model?: string | null },
    status: "started" | "failed",
    reason?: string,
  ): void {
    this.db.transaction((tx) => {
      const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
      if (!run) throw new Error(`Run ${runId} does not exist`);
      appendEvent(
        tx,
        {
          taskId: run.taskId,
          type: RUN_PROVIDER_ATTEMPT,
          actor: "system",
          payload: {
            runId,
            provider: attempt.provider,
            modelIndex: attempt.modelIndex,
            ...(attempt.model && { model: attempt.model }),
            status,
            ...(reason && { reason }),
          },
        },
        { publish: true },
      );
    });
  }

  /**
   * Model indexes of the profile already tried in the phase dispatch in progress, not counting the
   * open Run's own start attempts: the models of the closed Runs that ended because of their model
   * and those that failed to start (ADR agent-profiles). Reset by a success, a cancellation or a resume.
   */
  exhaustedModels(taskId: string, phase: Phase): number[] {
    return exhaustedModelIndexes(this.db, taskId, phase);
  }

  /**
   * Failure diagnostics of the phase dispatch in progress: one line per failed model, oldest
   * first, with the closed Runs of the dispatch and the open Run `openRunId`.
   */
  modelFailures(taskId: string, phase: Phase, openRunId?: string): string[] {
    const chain = dispatchRuns(this.db, taskId, phase);
    const ids = new Set(chain.map((r) => r.id));
    if (openRunId) ids.add(openRunId);
    const lines: string[] = [];
    const startFailures = providerAttemptsOf(this.db, taskId, (id) => ids.has(id)).filter(
      (a) => a.status === "failed",
    );
    for (const run of [...chain].reverse()) {
      for (const a of startFailures.filter((f) => f.runId === run.id)) {
        lines.push(
          `${describeModel(a.provider, a.model, a.modelIndex)}: ${a.reason ?? "failed to start"}`,
        );
      }
      if (run.modelFailed) {
        lines.push(
          `${describeModel(run.agentKind, run.model, run.modelIndex)}: ${run.failureReason ?? "failed"}`,
        );
      }
    }
    for (const a of startFailures.filter((f) => f.runId === openRunId)) {
      lines.push(
        `${describeModel(a.provider, a.model, a.modelIndex)}: ${a.reason ?? "failed to start"}`,
      );
    }
    return lines;
  }

  /** Marks that the phase prompt was sent; keeps the first mark. */
  markLaunched(runId: string): RunRow | null {
    this.db
      .update(runs)
      .set({ launchedAt: new Date() })
      .where(and(eq(runs.id, runId), isNull(runs.launchedAt)))
      .run();
    return this.get(runId);
  }

  /** Closes the Run only once: if it was already closed nothing changes and it returns closed false. */
  close(runId: string, input: CloseRunInput): { closed: boolean; run: RunRow | null } {
    const closed = closeRun(this.db, runId, input);
    return { closed, run: this.get(runId) };
  }

  /**
   * Failed Run that the agent did not declare (crash, dispatch that never launched): closes it as
   * failure and, if the task is still running in the Run's phase, applies `run_failed` with the same
   * count as `report_failure`. When retries run out the task goes to needs_human (ADR 0007).
   */
  fail(
    runId: string,
    reason: string,
    opts: { maxRetries?: number; providersUnavailable?: boolean; note?: string } = {},
  ): FailRunResult {
    return this.db.transaction(
      (tx) => {
        const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
        if (!run) throw new Error(`Run ${runId} does not exist`);
        // Before closing: the previous failures, plus this one.
        const attempt = consecutiveFailures(tx, run.taskId, run.phase) + 1;
        if (!closeRun(tx, runId, { result: "failure", failureReason: reason })) {
          return { closed: false, transitioned: false };
        }
        const task = tx.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
        if (task?.subState !== "running" || pendingPhase(task.state) !== run.phase) {
          return { closed: true, transitioned: false };
        }
        const moved = applyTransition(
          tx,
          opts.providersUnavailable
            ? {
                taskId: task.id,
                actor: "system",
                command: {
                  type: "escalate",
                  reason: "providers_unavailable",
                  ...(opts.note && { note: opts.note.slice(0, 2000) }),
                },
                expected: { state: task.state, subState: "running" },
              }
            : {
                taskId: task.id,
                actor: "system",
                command: {
                  type: "run_failed",
                  attempt,
                  ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
                },
                expected: { state: task.state, subState: "running" },
              },
        );
        if (!moved.ok) throw new Error(`run_failed de ${task.id}: ${moved.error.message}`);
        return { closed: true, transitioned: true, task: moved.task };
      },
      { behavior: "immediate" },
    );
  }

  /**
   * Paused dispatch: the human turned off all providers after the claim and before the
   * agent started. Closes the Run as cancelled (it does not count as a failure or use up retries) and
   * returns the task to queued so it waits for a provider to be enabled.
   */
  pause(runId: string, reason: string): FailRunResult {
    return this.db.transaction(
      (tx) => {
        const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
        if (!run) throw new Error(`Run ${runId} does not exist`);
        if (!closeRun(tx, runId, { result: "cancelled", failureReason: reason })) {
          return { closed: false, transitioned: false };
        }
        const task = tx.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
        if (task?.subState !== "running" || pendingPhase(task.state) !== run.phase) {
          return { closed: true, transitioned: false };
        }
        const moved = applyTransition(tx, {
          taskId: task.id,
          actor: "system",
          command: { type: "run_failed", attempt: 1 },
          expected: { state: task.state, subState: "running" },
        });
        if (!moved.ok) throw new Error(`pausa de ${task.id}: ${moved.error.message}`);
        return { closed: true, transitioned: true, task: moved.task };
      },
      { behavior: "immediate" },
    );
  }

  /**
   * The Run's model failed after launch (usage limit, the agent exited or stopped without the
   * end-of-phase signal): closes the Run as a model failure and, if the task is still running in the
   * Run's phase, sends it back to queued so the next pass dispatches the next model of the profile. It
   * consumes no retry and does not publish `run.failed` (no on_failure hook): it publishes
   * `run.model_fallback`.
   */
  failModel(runId: string, reason: string): FailRunResult {
    return this.db.transaction(
      (tx) => {
        const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
        if (!run) throw new Error(`Run ${runId} does not exist`);
        if (!closeRun(tx, runId, { result: "failure", failureReason: reason, modelFailed: true })) {
          return { closed: false, transitioned: false };
        }
        const task = tx.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
        if (task?.subState !== "running" || pendingPhase(task.state) !== run.phase) {
          return { closed: true, transitioned: false };
        }
        const moved = applyTransition(tx, {
          taskId: task.id,
          actor: "system",
          command: { type: "run_failed", attempt: 1 },
          expected: { state: task.state, subState: "running" },
        });
        if (!moved.ok) throw new Error(`model fallback of ${task.id}: ${moved.error.message}`);
        return { closed: true, transitioned: true, task: moved.task };
      },
      { behavior: "immediate" },
    );
  }

  /** Consecutive failed Runs of the phase, since the last successful one or the last resume (ADR 0007). */
  consecutiveFailures(taskId: string, phase: Phase): number {
    return consecutiveFailures(this.db, taskId, phase);
  }
}

export type CloseRunInput = {
  result: RunResult;
  failureReason?: string;
  handoff?: unknown;
  /** Session identity resolved on closing; without it the one from dispatch is kept. */
  session?: SessionIdentity;
  /**
   * The Run ended because of its model: it is recorded as such, consumes no retry and publishes
   * `run.model_fallback` instead of `run.failed`. Only with result `failure`.
   */
  modelFailed?: boolean;
};

export type FailRunResult = { closed: boolean; transitioned: boolean; task?: TaskRow };

/**
 * Closes the Run if it is still open; false if it was already closed. Closing as failure also appends
 * and publishes `run.failed` in the same transaction, so the event exists exactly once per Run: a repeated
 * close finds the Run closed and appends nothing.
 */
export function closeRun(
  db: Writer,
  runId: string,
  input: CloseRunInput,
  at = new Date(),
): boolean {
  return db.transaction((tx) => {
    const [closed] = tx
      .update(runs)
      .set({
        endedAt: at,
        result: input.result,
        failureReason: input.failureReason ?? null,
        ...(input.modelFailed && input.result === "failure" && { modelFailed: true }),
        ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
        ...(input.session && {
          agentSession: input.session.value,
          agentSessionSource: input.session.source,
        }),
      })
      .where(and(eq(runs.id, runId), isNull(runs.endedAt)))
      .returning({
        id: runs.id,
        taskId: runs.taskId,
        phase: runs.phase,
        modelIndex: runs.modelIndex,
      })
      .all();
    if (!closed) return false;
    if (input.result === "failure" && input.modelFailed) {
      const payload = RunModelFallbackPayload.parse({
        runId: closed.id,
        phase: closed.phase,
        modelIndex: closed.modelIndex ?? 0,
        reason: (input.failureReason || "unspecified").slice(0, 2000),
      });
      appendEvent(
        tx,
        { taskId: closed.taskId, type: RUN_MODEL_FALLBACK, actor: "system", payload },
        { publish: true },
      );
    } else if (input.result === "failure") {
      const payload = RunFailedPayload.parse({
        runId: closed.id,
        phase: closed.phase,
        reason: (input.failureReason || "unspecified").slice(0, 2000),
      });
      appendEvent(
        tx,
        { taskId: closed.taskId, type: RUN_FAILED, actor: "system", payload },
        { publish: true },
      );
    }
    return true;
  });
}

/**
 * Records the approver's verdict (ADR uw-23-verificacion): sets the task's risk label
 * and adds `verification.verdict_recorded` to the Event log and the outbox. It runs inside the
 * `submit_verdict` transaction.
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
 * Closed Runs of the phase dispatch in progress, newest first: the failed ones from the newest
 * backwards, up to one that did not fail or up to the task's last resume (ADR 0007, ADR agent-profiles).
 */
function dispatchRuns(db: Reader, taskId: string, phase: Phase): RunRow[] {
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
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.phase, phase),
        isNotNull(runs.endedAt),
        lastResume ? gt(runs.startedAt, lastResume.at) : undefined,
      ),
    )
    // rowid breaks ties between Runs of the same millisecond: it is the creation order.
    .orderBy(desc(runs.startedAt), sql`rowid desc`)
    .all();
  const firstOther = closed.findIndex((r) => r.result !== "failure");
  return firstOther === -1 ? closed : closed.slice(0, firstOther);
}

/**
 * Consecutive failed Runs of the phase, from the newest backwards, up to one that did not fail or up to
 * the task's last resume: it is the `attempt` of run_failed without counting the Run that is failing now.
 * A Run that ended because of its model (fallback) is not a failure of the phase and does not count.
 */
export function consecutiveFailures(db: Reader, taskId: string, phase: Phase): number {
  return dispatchRuns(db, taskId, phase).filter((r) => !r.modelFailed).length;
}

export type ProviderAttempt = {
  runId: string;
  provider: AgentKind;
  modelIndex: number;
  model?: string;
  status: "started" | "failed";
  reason?: string;
};

/** The start attempts (run.provider_attempt) of the task's Runs accepted by `include`, in order. */
function providerAttemptsOf(
  db: Reader,
  taskId: string,
  include: (runId: string) => boolean,
): ProviderAttempt[] {
  return db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.taskId, taskId), eq(events.type, RUN_PROVIDER_ATTEMPT)))
    .orderBy(asc(events.id))
    .all()
    .flatMap(({ payload }) => {
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return [];
      const event = payload as Record<string, unknown>;
      if (typeof event.runId !== "string" || !include(event.runId)) return [];
      const provider = AgentKind.safeParse(event.provider);
      const status = event.status === "started" || event.status === "failed" ? event.status : null;
      if (!provider.success || status === null) return [];
      return [
        {
          runId: event.runId,
          provider: provider.data,
          // Events from before profiles carry no index: they belong to the primary model.
          modelIndex: typeof event.modelIndex === "number" ? event.modelIndex : 0,
          ...(typeof event.model === "string" && { model: event.model }),
          status,
          ...(typeof event.reason === "string" && { reason: event.reason }),
        },
      ];
    });
}

function describeModel(
  kind: AgentKind,
  model: string | null | undefined,
  index: number | null | undefined,
) {
  return `#${(index ?? 0) + 1} ${kind}${model ? ` ${model}` : ""}`;
}

/**
 * Profile model indexes already tried in the phase dispatch in progress: the models of the closed Runs
 * that ended because of their model and those that failed to start in those Runs. A phase dispatch ends
 * with a Run that did not fail or with a resume, so the next one starts again from the top of the list.
 */
export function exhaustedModelIndexes(db: Reader, taskId: string, phase: Phase): number[] {
  const chain = dispatchRuns(db, taskId, phase);
  if (chain.length === 0) return [];
  const ids = new Set(chain.map((r) => r.id));
  const exhausted = new Set<number>();
  for (const run of chain)
    if (run.modelFailed && run.modelIndex !== null) exhausted.add(run.modelIndex);
  for (const a of providerAttemptsOf(db, taskId, (id) => ids.has(id))) {
    if (a.status === "failed") exhausted.add(a.modelIndex);
  }
  return [...exhausted].sort((x, y) => x - y);
}

export type CreateQuestionInput = {
  taskId: string;
  runId: string;
  question: string;
  context?: string;
  options?: QuestionOptions;
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
        options: input.options ?? null,
      })
      .returning()
      .all();
    if (!row) throw new Error("question insert without a row");
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

/** Appends the full checklist snapshot to the Event log. */
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
