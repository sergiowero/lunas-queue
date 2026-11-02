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
import { SettingsRepository } from "./settings.ts";
import { transitionTask } from "./task-transitions.ts";
import {
  freshDatabase,
  insertProject,
  insertRun,
  insertTask,
  migratedDatabase,
} from "./test-helpers.ts";

// --- LunasQ MCP ---

function mcpSetup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const task = insertTask(db, project.id, { state: "in_progress", subState: "running" });
  return { db, project, task, repo: new RunRepository(db) };
}

describe("RunRepository: what the LunasQ MCP uses", () => {
  it("activeByToken only finds Runs without ended_at", () => {
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

  it("byToken finds the Run even if it is closed", () => {
    const { db, task, repo } = mcpSetup();
    const old = insertRun(db, task.id, { endedAt: new Date(), result: "success" });
    expect(repo.byToken(old.runToken)?.id).toBe(old.id);
    expect(repo.byToken("desconocido")).toBeNull();
  });

  it("markContextRead stores the first read and does not move it on repeat", () => {
    const { db, task, repo } = mcpSetup();
    const run = insertRun(db, task.id);
    const first = repo.markContextRead(run.id);
    const again = repo.markContextRead(run.id);
    expect(first).toBeInstanceOf(Date);
    expect(again?.getTime()).toBe(first?.getTime());
    expect(repo.get(run.id)?.contextReadAt?.getTime()).toBe(first?.getTime());
  });

  it("closeRun closes only once with result, reason and handoff", () => {
    const { db, task, repo } = mcpSetup();
    const run = insertRun(db, task.id);
    const handoff = { phase: "implementation" };
    expect(closeRun(db, run.id, { result: "success", handoff })).toBe(true);
    expect(closeRun(db, run.id, { result: "failure", failureReason: "otra" })).toBe(false);
    expect(repo.get(run.id)).toMatchObject({ result: "success", handoff, failureReason: null });
    expect(repo.get(run.id)?.endedAt).toBeInstanceOf(Date);
  });

  it("recordHandoff stores the handoff and leaves the Run open", () => {
    const { db, task, repo } = mcpSetup();
    const run = insertRun(db, task.id, { phase: "verify" });
    repo.recordHandoff(run.id, { phase: "verification" });
    expect(repo.get(run.id)).toMatchObject({ handoff: { phase: "verification" }, endedAt: null });
  });

  it("deliveryInProgress: only with the verifier's Run open and its handoff saved", () => {
    const { db, task, repo } = mcpSetup();
    expect(repo.deliveryInProgress(task.id)).toBe(false);
    const run = insertRun(db, task.id, { phase: "verify" });
    expect(repo.deliveryInProgress(task.id)).toBe(false);
    repo.recordHandoff(run.id, { phase: "verification" });
    expect(repo.deliveryInProgress(task.id)).toBe(true);
    closeRun(db, run.id, { result: "success", handoff: { phase: "verification" } });
    expect(repo.deliveryInProgress(task.id)).toBe(false);
  });

  it("latestHandoffs returns the phase's handoffs, from oldest to newest", () => {
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

  it("latestHandoff returns the phase's last Run with a handoff, with its iteration", () => {
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

  it("previousRun is the phase's last closed Run, not counting the current one", () => {
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
  it("counts the phase's consecutive failed Runs up to one that did not fail", () => {
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

  it("a resume resets the count", () => {
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

describe("Questions and checklist", () => {
  it("createQuestion stores the open question and its event", () => {
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

  it("createQuestion stores the options in order and without them leaves options null", () => {
    const { db, task } = mcpSetup();
    const run = insertRun(db, task.id);
    const plain = createQuestion(db, { taskId: task.id, runId: run.id, question: "¿Abierta?" });
    expect(plain.options).toBeNull();
    const options = [{ label: "A", description: "primera" }, { label: "B" }, { label: "C" }];
    const withOptions = createQuestion(db, {
      taskId: task.id,
      runId: run.id,
      question: "¿Cuál?",
      options,
    });
    expect(withOptions.options).toEqual(options);
    const listed = listQuestions(db, task.id).find((q) => q.id === withOptions.id);
    expect(listed?.options).toEqual(options);
  });

  it("latestChecklist is the task's last snapshot", () => {
    const { db, task } = mcpSetup();
    const run = insertRun(db, task.id);
    expect(latestChecklist(db, task.id)).toBeNull();
    appendChecklist(db, task.id, run.id, [{ taskId: "T-1", title: "a", done: false }]);
    appendChecklist(db, task.id, run.id, [{ taskId: "T-1", title: "a", done: true }]);
    expect(latestChecklist(db, task.id)).toEqual([{ taskId: "T-1", title: "a", done: true }]);
  });
});

// --- Dispatcher ---

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

describe("claimRun and switchAgentKind: global limit saved in Settings", () => {
  it("the claim revalidates with the limit saved after planning and rejects without creating a Run", () => {
    const { db, project, claim } = setup({ config: { globalConcurrency: 2 } });
    const otro = insertProject(db);
    expect(claim(decisionFor(insertTask(db, otro.id))).ok).toBe(true);
    const task = insertTask(db, project.id);
    // The plan was made with limit 2 and one live agent; the human lowers the limit to 1 before the claim.
    new SettingsRepository(db).saveConcurrency({ globalConcurrency: 1 });

    const res = claim(decisionFor(task));

    expect(res).toMatchObject({ ok: false, error: { code: "no_slot" } });
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.subState).toBe("queued");
    expect(new RunRepository(db).forTask(task.id)).toEqual([]);
  });

  it("the claim accepts more agents than the default if Settings raises the limit", () => {
    const { db, project, claim } = setup({ config: { globalConcurrency: 1 } });
    new SettingsRepository(db).saveConcurrency({ globalConcurrency: 2 });
    const otro = insertProject(db);
    expect(claim(decisionFor(insertTask(db, project.id))).ok).toBe(true);
    expect(claim(decisionFor(insertTask(db, otro.id))).ok).toBe(true);
  });

  it("switchAgentKind rejects for lack of a slot with the saved limit, not with the default", () => {
    const { db, project, claim, projects, config, runs } = setup();
    const otro = insertProject(db);
    const mine = claim(decisionFor(insertTask(db, project.id)));
    if (!mine.ok) throw new Error(mine.error.message);
    expect(claim(decisionFor(insertTask(db, otro.id))).ok).toBe(true);
    // With the default (5) it would fit; the saved limit is already full because of the other live agent.
    new SettingsRepository(db).saveConcurrency({ globalConcurrency: 1 });

    expect(runs.switchAgentKind(mine.run.id, "copilot", null, { projects, config })).toBe(
      "no_slot",
    );
    expect(runs.get(mine.run.id)?.agentKind).toBe("claude");
  });
});

describe("claimRun: enabled providers", () => {
  it("with all providers disabled it rejects and the task stays in queued without a Run", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id);
    new SettingsRepository(db).saveProviders({ claude: false, copilot: false });

    const res = claim(decisionFor(task));

    expect(res).toMatchObject({ ok: false, error: { code: "providers_disabled" } });
    expect(
      db.$client.prepare("select state, sub_state as s from tasks where id = ?").get(task.id),
    ).toEqual({ state: "draft", s: "queued" });
    expect(new RunRepository(db).forTask(task.id)).toEqual([]);
  });

  it("with the primary disabled it creates the Run with the effective provider, without the primary's model", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id, { state: "in_progress" });
    new SettingsRepository(db).saveProviders({ claude: false, copilot: true });

    const res = claim(decisionFor(task, "implement", { state: "in_progress", subState: "queued" }));

    if (!res.ok) throw new Error(res.error.message);
    expect(res.run).toMatchObject({ agentKind: "copilot", model: null });
  });

  it("a live agent is not touched when its provider is disabled", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id);
    const res = claim(decisionFor(task));
    if (!res.ok) throw new Error(res.error.message);

    new SettingsRepository(db).saveProviders({ claude: false, copilot: false });

    expect(new RunRepository(db).get(res.run.id)).toMatchObject({ endedAt: null, result: null });
    expect(
      db.$client.prepare("select sub_state from tasks where id = ?").pluck().get(task.id),
    ).toBe("running");
  });
});

describe("claimRun", () => {
  it("moves the task to running and creates the Run with token, iteration, name and native session", () => {
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

  it("takes the model from the phase profile and the iteration from the task", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id, {
      state: "in_progress",
      verificationIteration: 2,
    });
    const res = claim(decisionFor(task, "implement", { state: "in_progress", subState: "queued" }));
    if (!res.ok) throw new Error(res.error.message);
    expect(res.run).toMatchObject({ model: "opus", iteration: 2 });
  });

  it("repeating the claim does not create another Run: the task is no longer where it was seen", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id);
    expect(claim(decisionFor(task)).ok).toBe(true);

    const again = claim(decisionFor(task));

    expect(again).toMatchObject({ ok: false, error: { code: "stale_state" } });
    expect(new RunRepository(db).forTask(task.id)).toHaveLength(1);
  });

  it("rejects with no_slot if the project limit is already full, without writing anything", () => {
    const { db, project, claim } = setup({ concurrency: 1 });
    const a = insertTask(db, project.id);
    const b = insertTask(db, project.id);
    expect(claim(decisionFor(a)).ok).toBe(true);

    const res = claim(decisionFor(b));

    expect(res).toMatchObject({ ok: false, error: { code: "no_slot" } });
    expect(db.select().from(tasks).where(eq(tasks.id, b.id)).get()?.subState).toBe("queued");
    expect(new RunRepository(db).forTask(b.id)).toEqual([]);
  });

  it("two processes with the same decision: only one claims", () => {
    // Another connection to the same file, like the CLI next to the server.
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

  it("rejects with no_slot if the global limit is full", () => {
    const { db, project, claim } = setup({ config: { globalConcurrency: 1 } });
    const other = insertProject(db);
    expect(claim(decisionFor(insertTask(db, project.id))).ok).toBe(true);
    expect(claim(decisionFor(insertTask(db, other.id)))).toMatchObject({
      ok: false,
      error: { code: "no_slot" },
    });
  });

  it("rejects with run_active if the task still has an open Run", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id, { state: "verification" });
    insertRun(db, task.id, { phase: "implement" });

    const res = claim(decisionFor(task, "verify", { state: "verification", subState: "queued" }));

    expect(res).toMatchObject({ ok: false, error: { code: "run_active" } });
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.subState).toBe("queued");
  });

  it("the name ordinal counts the phase's previous Runs", () => {
    const { db, project, claim } = setup();
    const task = insertTask(db, project.id);
    insertRun(db, task.id, { phase: "refine", endedAt: new Date(), result: "failure" });
    insertRun(db, task.id, { phase: "implement", endedAt: new Date(), result: "success" });

    const res = claim(decisionFor(task));

    if (!res.ok) throw new Error(res.error.message);
    expect(res.run.herdrName).toBe(agentName(task.id, "refine", 2));
  });

  it("rejects a phase that does not match the task's state", () => {
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

  it("stores pane and workspace and marks the launch only once", () => {
    const { runs, run } = claimed();
    runs.recordPane(run.id, { workspaceId: "w2", paneId: "w2:p2" });
    const first = runs.markLaunched(run.id);
    const second = runs.markLaunched(run.id);
    expect(runs.get(run.id)).toMatchObject({ herdrWorkspace: "w2", herdrPane: "w2:p2" });
    expect(first?.launchedAt).toBeInstanceOf(Date);
    expect(second?.launchedAt?.getTime()).toBe(first?.launchedAt?.getTime());
  });

  it("byToken finds only the active Run", () => {
    const { runs, run } = claimed();
    expect(runs.activeByToken(run.runToken)?.id).toBe(run.id);
    runs.close(run.id, { result: "success" });
    expect(runs.activeByToken(run.runToken)).toBeNull();
  });

  it("close is idempotent: the first close wins", () => {
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

  it("close without session keeps the identity saved at dispatch", () => {
    const { runs, run } = claimed();
    runs.close(run.id, { result: "success" });
    expect(runs.get(run.id)).toMatchObject({
      agentSession: "sess-1",
      agentSessionSource: "native",
    });
  });

  it("active lists the Runs without ended_at", () => {
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

  it("closes the Run as failure and returns the task to queued with the attempt counted", () => {
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

  it("pause closes the Run as cancelled, returns the task to queued and does not count as a failure", () => {
    const { db, runs, task, claimOnce } = claimedInProgress();
    // Three previous failures: the pause does not add the fourth one that would escalate to needs_human.
    for (let i = 0; i < 3; i++) runs.fail(claimOnce().id, `fallo ${i}`);
    const run = claimOnce();

    const res = runs.pause(run.id, "all providers are disabled in Settings");

    expect(res).toMatchObject({ closed: true, transitioned: true });
    expect(runs.get(run.id)).toMatchObject({
      result: "cancelled",
      failureReason: "all providers are disabled in Settings",
    });
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()).toMatchObject({
      state: "in_progress",
      subState: "queued",
    });
    expect(runs.pause(run.id, "otra vez")).toEqual({ closed: false, transitioned: false });
  });

  it("consecutive failures use up the retries and escalate to needs_human", () => {
    const { db, runs, task, claimOnce } = claimedInProgress();
    for (let i = 0; i < 3; i++) runs.fail(claimOnce().id, `fallo ${i}`);
    runs.fail(claimOnce().id, "cuarto fallo");
    const row = db.select().from(tasks).where(eq(tasks.id, task.id)).get();
    expect(row).toMatchObject({ state: "needs_human", subState: null });
  });

  it("a successful Run or a resume resets the count", () => {
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

  it("the failing Run counts even if it starts in the same ms as the last resume", () => {
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

  it("is idempotent and does not move a task that already left running", () => {
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

  it("sets the task's risk label and publishes the verdict event", () => {
    const { db, task } = mcpSetup();
    const run = insertRun(db, task.id, { phase: "verify" });
    recordVerdict(db, task.id, payload(run.id));
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.riskLabel).toBe("high");
    const [event] = listEvents(db, task.id).filter((e) => e.type === VERDICT_RECORDED);
    expect(event).toMatchObject({ actor: "agent", payload: payload(run.id) });
    const queued = db.select().from(outbox).all();
    expect(queued.map((o) => o.eventId)).toContain(event?.id);
  });

  it("rejects an invalid payload without writing anything", () => {
    const { db, task } = mcpSetup();
    expect(() =>
      recordVerdict(db, task.id, { ...payload("no-uuid"), riskLabel: "x" } as never),
    ).toThrow();
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.riskLabel).toBeNull();
  });
});
