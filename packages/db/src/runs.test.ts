import { agentName } from "@lunasq/domain";
import { SchedulerConfig, type SchedulerConfigInput, TASK_TRANSITIONED } from "@lunasq/schemas";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { migrateDatabase, openDatabase } from "./client.ts";
import { ProjectRepository } from "./projects.ts";
import { type ClaimDecision, claimRun, RunRepository } from "./runs.ts";
import { events, tasks } from "./schema.ts";
import { transitionTask } from "./task-transitions.ts";
import {
  freshDatabase,
  insertProject,
  insertRun,
  insertTask,
  migratedDatabase,
} from "./test-helpers.ts";

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
    expect(runs.activeByToken(run.runToken)).toBeUndefined();
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
