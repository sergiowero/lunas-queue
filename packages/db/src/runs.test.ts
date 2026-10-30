import { agentName } from "@lunasq/domain";
import {
  SchedulerConfig,
  type SchedulerConfigInput,
  TASK_TRANSITIONED,
  VERDICT_RECORDED,
} from "@lunasq/schemas";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { migrateDatabase, openDatabase } from "./client.ts";
import { listEvents } from "./event-log.ts";
import { ProjectRepository } from "./projects.ts";
import {
  appendChecklist,
  type ClaimDecision,
  claimRun,
  closeRun,
  consecutiveFailures,
  createQuestion,
  latestChecklist,
  listQuestions,
  RunRepository,
  recordVerdict,
} from "./runs.ts";
import { events, outbox, tasks } from "./schema.ts";
import { transitionTask } from "./task-transitions.ts";
import {
  freshDatabase,
  insertProject,
  insertRun,
  insertTask,
  migratedDatabase,
} from "./test-helpers.ts";

// --- LunasQ MCP (UW-15) ---

function mcpSetup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const task = insertTask(db, project.id, { state: "in_progress", subState: "running" });
  return { db, project, task, repo: new RunRepository(db) };
}

describe("RunRepository: lo que usa el LunasQ MCP", () => {
  it("activeByToken solo encuentra Runs sin ended_at", () => {
    const { db, task, repo } = mcpSetup();
    const old = insertRun(db, task.id, {
      runToken: "viejo",
      endedAt: new Date(),
      result: "failure",
    });
    const active = insertRun(db, task.id, { runToken: "vigente" });
    expect(repo.activeByToken("vigente")?.id).toBe(active.id);
    expect(repo.activeByToken(old.runToken)).toBeNull();
    expect(repo.activeByToken("desconocido")).toBeNull();
  });

  it("markContextRead guarda la primera lectura y no la mueve al repetir", () => {
    const { db, task, repo } = mcpSetup();
    const run = insertRun(db, task.id);
    const first = repo.markContextRead(run.id);
    const again = repo.markContextRead(run.id);
    expect(first).toBeInstanceOf(Date);
    expect(again?.getTime()).toBe(first?.getTime());
    expect(repo.get(run.id)?.contextReadAt?.getTime()).toBe(first?.getTime());
  });

  it("closeRun cierra una sola vez con resultado, motivo y handoff", () => {
    const { db, task, repo } = mcpSetup();
    const run = insertRun(db, task.id);
    const handoff = { phase: "implementation" };
    expect(closeRun(db, run.id, { result: "success", handoff })).toBe(true);
    expect(closeRun(db, run.id, { result: "failure", failureReason: "otra" })).toBe(false);
    expect(repo.get(run.id)).toMatchObject({ result: "success", handoff, failureReason: null });
    expect(repo.get(run.id)?.endedAt).toBeInstanceOf(Date);
  });

  it("recordHandoff guarda el handoff y deja el Run abierto", () => {
    const { db, task, repo } = mcpSetup();
    const run = insertRun(db, task.id, { phase: "verify" });
    repo.recordHandoff(run.id, { phase: "verification" });
    expect(repo.get(run.id)).toMatchObject({ handoff: { phase: "verification" }, endedAt: null });
  });

  it("latestHandoffs devuelve los handoffs de la fase, del más viejo al más nuevo", () => {
    const { db, task, repo } = mcpSetup();
    const first = insertRun(db, task.id, { phase: "verify", startedAt: new Date(1000) });
    closeRun(db, first.id, { result: "success", handoff: { n: 1 } });
    const failed = insertRun(db, task.id, { phase: "verify", startedAt: new Date(2000) });
    closeRun(db, failed.id, { result: "failure", failureReason: "x" });
    const second = insertRun(db, task.id, { phase: "verify", startedAt: new Date(3000) });
    closeRun(db, second.id, { result: "success", handoff: { n: 2 } });
    expect(repo.handoffs(task.id, "verify")).toEqual([{ n: 1 }, { n: 2 }]);
    expect(repo.handoffs(task.id, "implement")).toEqual([]);
  });

  it("latestHandoff devuelve el último Run de la fase con handoff, con su iteración", () => {
    const { db, task, repo } = mcpSetup();
    expect(repo.latestHandoff(task.id, "verify")).toBeNull();
    const first = insertRun(db, task.id, {
      phase: "verify",
      iteration: 0,
      startedAt: new Date(1000),
    });
    closeRun(db, first.id, { result: "success", handoff: { n: 1 } });
    const second = insertRun(db, task.id, {
      phase: "verify",
      iteration: 1,
      startedAt: new Date(2000),
    });
    closeRun(db, second.id, { result: "success", handoff: { n: 2 } });
    const open = insertRun(db, task.id, { phase: "verify", startedAt: new Date(3000) });
    closeRun(db, open.id, { result: "failure", failureReason: "x" });
    expect(repo.latestHandoff(task.id, "verify")).toEqual({
      runId: second.id,
      iteration: 1,
      handoff: { n: 2 },
    });
  });

  it("previousRun es el último Run cerrado de la fase, sin contar el actual", () => {
    const { db, task, repo } = mcpSetup();
    const failed = insertRun(db, task.id, { startedAt: new Date(1000) });
    closeRun(db, failed.id, { result: "failure", failureReason: "no compila" });
    const current = insertRun(db, task.id, { startedAt: new Date(2000) });
    expect(repo.previousRun(task.id, "implement", current.id)).toMatchObject({
      id: failed.id,
      failureReason: "no compila",
    });
    expect(repo.previousRun(task.id, "refine", current.id)).toBeNull();
  });
});

describe("consecutiveFailures", () => {
  it("cuenta los Runs fallidos seguidos de la fase hasta uno que no falló", () => {
    const { db, task } = mcpSetup();
    const ok = insertRun(db, task.id, { startedAt: new Date(1000) });
    closeRun(db, ok.id, { result: "success" });
    for (const at of [2000, 3000]) {
      const run = insertRun(db, task.id, { startedAt: new Date(at) });
      closeRun(db, run.id, { result: "failure", failureReason: "x" });
    }
    const other = insertRun(db, task.id, { phase: "verify", startedAt: new Date(4000) });
    closeRun(db, other.id, { result: "failure", failureReason: "x" });
    expect(consecutiveFailures(db, task.id, "implement")).toBe(2);
    expect(consecutiveFailures(db, task.id, "verify")).toBe(1);
  });

  it("un resume reinicia la cuenta", () => {
    const { db, project } = mcpSetup();
    const task = insertTask(db, project.id, { state: "in_progress", subState: "running" });
    const failed = insertRun(db, task.id, { startedAt: new Date(1000) });
    closeRun(db, failed.id, { result: "failure", failureReason: "x" });
    const escalated = transitionTask(db, {
      taskId: task.id,
      actor: "system",
      command: { type: "escalate", reason: "retries_exhausted" },
    });
    expect(escalated.ok).toBe(true);
    const resumed = transitionTask(db, {
      taskId: task.id,
      actor: "human",
      command: { type: "resume" },
    });
    expect(resumed.ok).toBe(true);
    expect(consecutiveFailures(db, task.id, "implement")).toBe(0);
  });
});

describe("Questions y checklist", () => {
  it("createQuestion guarda la pregunta abierta y su evento", () => {
    const { db, task } = mcpSetup();
    const run = insertRun(db, task.id);
    const question = createQuestion(db, {
      taskId: task.id,
      runId: run.id,
      question: "¿Uso la tabla vieja?",
      context: "hay dos",
    });
    expect(question).toMatchObject({ status: "open", runId: run.id, answer: null });
    expect(listQuestions(db, task.id).map((q) => q.id)).toEqual([question.id]);
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      type: "question.created",
      actor: "agent",
      payload: { questionId: question.id, runId: run.id },
    });
  });

  it("latestChecklist es el último snapshot de la tarea", () => {
    const { db, task } = mcpSetup();
    const run = insertRun(db, task.id);
    expect(latestChecklist(db, task.id)).toBeNull();
    appendChecklist(db, task.id, run.id, [{ taskId: "T-1", title: "a", done: false }]);
    appendChecklist(db, task.id, run.id, [{ taskId: "T-1", title: "a", done: true }]);
    expect(latestChecklist(db, task.id)).toEqual([{ taskId: "T-1", title: "a", done: true }]);
  });
});

// --- Dispatcher (UW-16) ---

function setup(opts: { concurrency?: number; config?: SchedulerConfigInput } = {}) {
  const db = migratedDatabase();
  const project = insertProject(db, {
    limits: opts.concurrency === undefined ? {} : { concurrency: opts.concurrency },
    agentProfiles: { implement: { kind: "claude", model: "opus", args: [] } },
  });
  const projects = new ProjectRepository(db);
  const config = SchedulerConfig.parse(opts.config ?? {});
  const runs = new RunRepository(db);
  const claim = (decision: ClaimDecision) =>
    claimRun(db, { decision, config, projects, sessionId: "sess-1" });
  return { db, project, projects, config, runs, claim };
}

const decisionFor = (
  task: { id: string; projectId: string },
  phase: ClaimDecision["phase"] = "refine",
  expected: ClaimDecision["expected"] = { state: "draft", subState: "queued" },
): ClaimDecision => ({ taskId: task.id, projectId: task.projectId, phase, expected });

describe("claimRun", () => {
  it("mueve la tarea a running y crea el Run con token, iteración, nombre y sesión nativa", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id);

    const res = claim(decisionFor(task));

    if (!res.ok) throw new Error(res.error.message);
    expect(res.task).toMatchObject({ state: "draft", subState: "running" });
    expect(res.run).toMatchObject({
      taskId: task.id,
      phase: "refine",
      agentKind: "claude",
      iteration: 0,
      herdrName: agentName(task.id, "refine", 1),
      agentSession: "sess-1",
      agentSessionSource: "native",
      endedAt: null,
      launchedAt: null,
    });
    expect(res.run.runToken).toMatch(/^[0-9a-f]{64}$/);
    const transitions = db.select().from(events).where(eq(events.type, TASK_TRANSITIONED)).all();
    expect(transitions).toHaveLength(1);
  });

  it("toma el modelo del perfil de la fase y la iteración de la tarea", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id, {
      state: "in_progress",
      verificationIteration: 2,
    });
    const res = claim(decisionFor(task, "implement", { state: "in_progress", subState: "queued" }));
    if (!res.ok) throw new Error(res.error.message);
    expect(res.run).toMatchObject({ model: "opus", iteration: 2 });
  });

  it("repetir el claim no crea otro Run: la tarea ya no está donde se vio", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id);
    expect(claim(decisionFor(task)).ok).toBe(true);

    const again = claim(decisionFor(task));

    expect(again).toMatchObject({ ok: false, error: { code: "stale_state" } });
    expect(new RunRepository(db).forTask(task.id)).toHaveLength(1);
  });

  it("rechaza con no_slot si el límite del proyecto ya está lleno, sin escribir nada", () => {
    const { db, project, claim } = setup({ concurrency: 1 });
    const a = insertTask(db, project.id);
    const b = insertTask(db, project.id);
    expect(claim(decisionFor(a)).ok).toBe(true);

    const res = claim(decisionFor(b));

    expect(res).toMatchObject({ ok: false, error: { code: "no_slot" } });
    expect(db.select().from(tasks).where(eq(tasks.id, b.id)).get()?.subState).toBe("queued");
    expect(new RunRepository(db).forTask(b.id)).toEqual([]);
  });

  it("dos procesos con la misma decisión: solo uno reclama", () => {
    // Otra conexión al mismo archivo, como la CLI junto al servidor.
    const { db, file } = freshDatabase();
    migrateDatabase(db);
    const other = openDatabase(file);
    try {
      const project = insertProject(db);
      const task = insertTask(db, project.id);
      const config = SchedulerConfig.parse({});
      const claimWith = (conn: typeof db) =>
        claimRun(conn, {
          decision: decisionFor(task),
          config,
          projects: new ProjectRepository(conn),
          sessionId: "s",
        });
      const results = [claimWith(db), claimWith(other)];
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ error: { code: "stale_state" } });
      expect(new RunRepository(db).forTask(task.id)).toHaveLength(1);
    } finally {
      other.$client.close();
    }
  });

  it("rechaza con no_slot si el límite global está lleno", () => {
    const { db, project, claim } = setup({ config: { globalConcurrency: 1 } });
    const other = insertProject(db);
    expect(claim(decisionFor(insertTask(db, project.id))).ok).toBe(true);
    expect(claim(decisionFor(insertTask(db, other.id)))).toMatchObject({
      ok: false,
      error: { code: "no_slot" },
    });
  });

  it("rechaza con run_active si la tarea aún tiene un Run abierto", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id, { state: "verification" });
    insertRun(db, task.id, { phase: "implement" });

    const res = claim(decisionFor(task, "verify", { state: "verification", subState: "queued" }));

    expect(res).toMatchObject({ ok: false, error: { code: "run_active" } });
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.subState).toBe("queued");
  });

  it("el ordinal del nombre cuenta los Runs previos de la fase", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id);
    insertRun(db, task.id, { phase: "refine", endedAt: new Date(), result: "failure" });
    insertRun(db, task.id, { phase: "implement", endedAt: new Date(), result: "success" });

    const res = claim(decisionFor(task));

    if (!res.ok) throw new Error(res.error.message);
    expect(res.run.herdrName).toBe(agentName(task.id, "refine", 2));
  });

  it("rechaza una fase que no corresponde al estado de la tarea", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id);
    expect(claim(decisionFor(task, "verify"))).toMatchObject({
      ok: false,
      error: { code: "phase_mismatch" },
    });
  });
});

describe("RunRepository", () => {
  function claimed() {
    const ctx = setup();
    const task = insertTask(ctx.db, ctx.project.id);
    const res = ctx.claim(decisionFor(task));
    if (!res.ok) throw new Error(res.error.message);
    return { ...ctx, task, run: res.run };
  }

  it("guarda pane y workspace y marca el lanzamiento una sola vez", () => {
    const { runs, run } = claimed();
    runs.recordPane(run.id, { workspaceId: "w2", paneId: "w2:p2" });
    const first = runs.markLaunched(run.id);
    const second = runs.markLaunched(run.id);
    expect(runs.get(run.id)).toMatchObject({ herdrWorkspace: "w2", herdrPane: "w2:p2" });
    expect(first?.launchedAt).toBeInstanceOf(Date);
    expect(second?.launchedAt?.getTime()).toBe(first?.launchedAt?.getTime());
  });

  it("byToken encuentra solo el Run activo", () => {
    const { runs, run } = claimed();
    expect(runs.activeByToken(run.runToken)?.id).toBe(run.id);
    runs.close(run.id, { result: "success" });
    expect(runs.activeByToken(run.runToken)).toBeNull();
  });

  it("close es idempotente: el primer cierre gana", () => {
    const { runs, run } = claimed();
    const first = runs.close(run.id, {
      result: "success",
      handoff: { ok: true },
      session: { value: "h-1", source: "herdr" },
    });
    const second = runs.close(run.id, { result: "failure", failureReason: "tarde" });
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(runs.get(run.id)).toMatchObject({
      result: "success",
      handoff: { ok: true },
      failureReason: null,
      agentSession: "h-1",
      agentSessionSource: "herdr",
    });
    expect(runs.get(run.id)?.endedAt).toBeInstanceOf(Date);
  });

  it("close sin session conserva la identidad guardada al despachar", () => {
    const { runs, run } = claimed();
    runs.close(run.id, { result: "success" });
    expect(runs.get(run.id)).toMatchObject({
      agentSession: "sess-1",
      agentSessionSource: "native",
    });
  });

  it("active lista los Runs sin ended_at", () => {
    const { runs, run } = claimed();
    expect(runs.active().map((r) => r.id)).toEqual([run.id]);
    runs.close(run.id, { result: "cancelled" });
    expect(runs.active()).toEqual([]);
  });
});

describe("RunRepository.fail", () => {
  function claimedInProgress() {
    const ctx = setup();
    const task = insertTask(ctx.db, ctx.project.id, { state: "in_progress" });
    const claimOnce = () => {
      const res = ctx.claim(
        decisionFor(task, "implement", { state: "in_progress", subState: "queued" }),
      );
      if (!res.ok) throw new Error(res.error.message);
      return res.run;
    };
    return { ...ctx, task, claimOnce };
  }

  it("cierra el Run como failure y devuelve la tarea a queued con el intento contado", () => {
    const { db, runs, task, claimOnce } = claimedInProgress();
    const run = claimOnce();

    const res = runs.fail(run.id, "pane cerrado");

    expect(res).toMatchObject({ closed: true, transitioned: true });
    expect(runs.get(run.id)).toMatchObject({ result: "failure", failureReason: "pane cerrado" });
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()).toMatchObject({
      state: "in_progress",
      subState: "queued",
    });
  });

  it("los fallos consecutivos agotan los reintentos y escalan a needs_human", () => {
    const { db, runs, task, claimOnce } = claimedInProgress();
    for (let i = 0; i < 3; i++) runs.fail(claimOnce().id, `fallo ${i}`);
    runs.fail(claimOnce().id, "cuarto fallo");
    const row = db.select().from(tasks).where(eq(tasks.id, task.id)).get();
    expect(row).toMatchObject({ state: "needs_human", subState: null });
  });

  it("un Run exitoso o un resume reinician la cuenta", () => {
    const { db, runs, task, claimOnce } = claimedInProgress();
    runs.fail(claimOnce().id, "a");
    runs.fail(claimOnce().id, "b");
    expect(runs.consecutiveFailures(task.id, "implement")).toBe(2);
    transitionTask(db, {
      taskId: task.id,
      actor: "system",
      command: { type: "escalate", reason: "phase_timeout" },
    });
    transitionTask(db, { taskId: task.id, actor: "human", command: { type: "resume" } });
    expect(runs.consecutiveFailures(task.id, "implement")).toBe(0);
    const ok = claimOnce();
    runs.close(ok.id, { result: "success" });
    expect(runs.consecutiveFailures(task.id, "implement")).toBe(0);
  });

  it("el Run que falla cuenta aunque empiece en el mismo ms que el último resume", () => {
    const { db, runs, task, claimOnce } = claimedInProgress();
    runs.fail(claimOnce().id, "a");
    transitionTask(db, {
      taskId: task.id,
      actor: "system",
      command: { type: "escalate", reason: "phase_timeout" },
    });
    transitionTask(db, { taskId: task.id, actor: "human", command: { type: "resume" } });
    const run = claimOnce();
    db.$client
      .prepare(
        "update runs set started_at = (select max(created_at) from events where task_id = ?) where id = ?",
      )
      .run(task.id, run.id);

    expect(runs.fail(run.id, "b")).toMatchObject({ closed: true, transitioned: true });
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.subState).toBe("queued");
  });

  it("es idempotente y no mueve una tarea que ya salió de running", () => {
    const { db, runs, task, claimOnce } = claimedInProgress();
    const run = claimOnce();
    transitionTask(db, {
      taskId: task.id,
      actor: "system",
      command: { type: "escalate", reason: "phase_timeout" },
    });

    const res = runs.fail(run.id, "tarde");
    const again = runs.fail(run.id, "otra vez");

    expect(res).toMatchObject({ closed: true, transitioned: false });
    expect(again).toMatchObject({ closed: false, transitioned: false });
    const failures = db
      .select()
      .from(events)
      .where(and(eq(events.taskId, task.id), eq(events.type, TASK_TRANSITIONED)))
      .all()
      .filter((e) => (e.payload as { command: string }).command === "run_failed");
    expect(failures).toEqual([]);
  });
});

describe("recordVerdict", () => {
  const payload = (runId: string) => ({
    runId,
    verdict: "reject" as const,
    iteration: 0,
    riskLabel: "high" as const,
    mustFix: 1,
    refuted: 0,
    skippedReviewers: [],
  });

  it("fija la etiqueta de riesgo de la tarea y publica el evento del veredicto", () => {
    const { db, task } = mcpSetup();
    const run = insertRun(db, task.id, { phase: "verify" });
    recordVerdict(db, task.id, payload(run.id));
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.riskLabel).toBe("high");
    const [event] = listEvents(db, task.id).filter((e) => e.type === VERDICT_RECORDED);
    expect(event).toMatchObject({ actor: "agent", payload: payload(run.id) });
    const queued = db.select().from(outbox).all();
    expect(queued.map((o) => o.eventId)).toContain(event?.id);
  });

  it("rechaza un payload inválido sin escribir nada", () => {
    const { db, task } = mcpSetup();
    expect(() =>
      recordVerdict(db, task.id, { ...payload("no-uuid"), riskLabel: "x" } as never),
    ).toThrow();
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.riskLabel).toBeNull();
  });
});
