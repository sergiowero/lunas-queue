import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr, FakeProcessRunner } from "@lunasq/adapters";
import {
  applyTransition,
  claimRun,
  closeRun,
  createQuestion,
  ProjectRepository,
  QuestionRepository,
  RunRepository,
  transitionTask,
} from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { type Notification, SchedulerConfig, type SchedulerConfigInput } from "@lunasq/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Escalator } from "../notifications/escalator.ts";
import { OutboxPublisher } from "../outbox/publisher.ts";
import type { RunEvidenceSink } from "./dispatcher.ts";
import { Orchestrator } from "./orchestrator.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function setup(
  opts: {
    config?: SchedulerConfigInput;
    db?: ReturnType<typeof migratedDatabase>;
    herdr?: FakeHerdr;
    escalationDelayMs?: number;
    evidence?: RunEvidenceSink;
  } = {},
) {
  const db = opts.db ?? migratedDatabase();
  const dir = mkdtempSync(join(tmpdir(), "lunasq-orch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  // Prompts do not end on their own: no nudges in the middle of the scenarios.
  const herdr = opts.herdr ?? new FakeHerdr({ promptDurationMs: 2 ** 31 - 1 });
  const publisher = new OutboxPublisher({ db, pollIntervalMs: 10 });
  const notifications: Notification[] = [];
  const notify = (n: Notification) => {
    notifications.push(n);
  };
  const escalator = new Escalator({
    notify,
    ...(opts.escalationDelayMs !== undefined && { delayMs: opts.escalationDelayMs }),
  });
  cleanups.push(() => escalator.stop());
  const orchestrator = new Orchestrator({
    db,
    herdr,
    processes: new FakeProcessRunner(),
    mcp: { configPath: join(dir, "mcp.json"), url: "http://127.0.0.1:4518/mcp" },
    hooks: {
      settingsPath: join(dir, "settings.json"),
      url: "http://127.0.0.1:4518/hooks/subagent",
    },
    publisher,
    notifications: { notify, escalator },
    ...(opts.evidence && { evidence: opts.evidence }),
    config: { tickIntervalMs: 60_000, ...opts.config },
  });
  cleanups.push(() => orchestrator.stop());
  const project = opts.db
    ? (new ProjectRepository(db).list()[0] ?? insertProject(db))
    : insertProject(db);
  return { db, dir, herdr, publisher, orchestrator, notifications, project, escalator };
}

describe("Orchestrator", () => {
  it("on start it writes the MCP file and dispatches what is ready", async () => {
    const { db, dir, herdr, orchestrator, project } = setup();
    const task = insertTask(db, project.id);

    await orchestrator.start();
    await orchestrator.dispatcher.idle();

    expect(readFileSync(join(dir, "mcp.json"), "utf8")).toContain(`\${LUNASQ_RUN_TOKEN}`);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toContain("/hooks/subagent");
    const [run] = new RunRepository(db).forTask(task.id);
    expect(run?.launchedAt).toBeInstanceOf(Date);
    expect((await herdr.snapshot()).agents.map((a) => a.name)).toEqual([run?.herdrName]);
  });

  it("on start it resumes a Run claimed before the crash", async () => {
    const { db, herdr, orchestrator, project } = setup();
    const task = insertTask(db, project.id);
    const claim = claimRun(db, {
      decision: {
        taskId: task.id,
        projectId: project.id,
        phase: "refine",
        expected: { state: "draft", subState: "queued" },
      },
      config: SchedulerConfig.parse({}),
      projects: new ProjectRepository(db),
      sessionId: "s-1",
    });
    if (!claim.ok) throw new Error(claim.error.message);

    await orchestrator.start();
    await orchestrator.dispatcher.idle();

    expect((await herdr.snapshot()).agents.map((a) => a.name)).toEqual([claim.run.herdrName]);
  });

  it("a new task that enters through the outbox is dispatched", async () => {
    const { db, herdr, orchestrator, publisher, project } = setup();
    await orchestrator.start();
    await publisher.start();
    cleanups.push(() => publisher.stop());

    const task = insertTask(db, project.id);
    // Any transition writes outbox; here it is enough to wake the scheduler by the tick.
    await orchestrator.scheduler.run();
    await orchestrator.dispatcher.idle();

    const [run] = new RunRepository(db).forTask(task.id);
    expect((await herdr.snapshot()).agents.map((a) => a.name)).toEqual([run?.herdrName]);
  });

  it("when an MCP tool closes the Run and the task leaves running, it cleans the pane", async () => {
    const { db, herdr, orchestrator, publisher, project } = setup();
    const task = insertTask(db, project.id);
    await orchestrator.start();
    await orchestrator.dispatcher.idle();
    const [run] = new RunRepository(db).forTask(task.id);
    if (!run?.herdrName) throw new Error("sin Run");
    expect(await herdr.getAgent(run.herdrName)).toBeDefined();

    // Like the exit tool: it closes the Run and transitions in the same transaction.
    db.transaction((tx) => {
      closeRun(tx, run.id, { result: "failure", failureReason: "x" });
    });
    transitionTask(db, {
      taskId: task.id,
      actor: "system",
      command: { type: "escalate", reason: "phase_timeout" },
    });
    await publisher.start();
    cleanups.push(() => publisher.stop());

    await vi.waitFor(async () => expect(await herdr.getAgent(run.herdrName ?? "")).toBeUndefined());
  });

  it("records the evidence of the Run that an MCP tool closed when the task leaves running", async () => {
    const recorded: string[] = [];
    const { db, herdr, orchestrator, publisher, project } = setup({
      evidence: { recordRun: async (id) => void recorded.push(id) },
    });
    const task = insertTask(db, project.id);
    await orchestrator.start();
    await orchestrator.dispatcher.idle();
    const [run] = new RunRepository(db).forTask(task.id);
    if (!run?.herdrName) throw new Error("sin Run");

    closeRun(db, run.id, { result: "failure", failureReason: "x" });
    transitionTask(db, {
      taskId: task.id,
      actor: "system",
      command: { type: "escalate", reason: "phase_timeout" },
    });
    await publisher.start();
    cleanups.push(() => publisher.stop());

    await vi.waitFor(async () => expect(await herdr.getAgent(run.herdrName ?? "")).toBeUndefined());
    expect(recorded).toEqual([run.id]);
  });

  it("an open Run is not cleaned even if the transition arrives", async () => {
    const { db, herdr, orchestrator, project } = setup();
    const task = insertTask(db, project.id);
    await orchestrator.start();
    await orchestrator.dispatcher.idle();
    const [run] = new RunRepository(db).forTask(task.id);
    await orchestrator.dispatcher.releaseRun(run?.id ?? "");
    expect(await herdr.getAgent(run?.herdrName ?? "")).toBeDefined();
  });
});

describe("Orchestrator: failure scenarios", () => {
  const taskState = (db: ReturnType<typeof migratedDatabase>, id: string) =>
    db.$client.prepare("select state, sub_state as subState from tasks where id = ?").get(id) as {
      state: string;
      subState: string | null;
    };

  async function startAll(ctx: ReturnType<typeof setup>) {
    await ctx.orchestrator.start();
    await ctx.publisher.start();
    cleanups.push(() => ctx.publisher.stop());
  }

  it("each crash retries after the backoff and, with the 3 retries exhausted, needs_human with a notice", async () => {
    const ctx = setup({ config: { retryBackoffMs: 0 } });
    const { db, herdr, orchestrator, project, notifications } = ctx;
    const task = insertTask(db, project.id);
    const runs = new RunRepository(db);
    await startAll(ctx);

    for (let attempt = 1; attempt <= 4; attempt++) {
      await vi.waitFor(
        async () => {
          await orchestrator.scheduler.run();
          await orchestrator.dispatcher.idle();
          expect(runs.forTask(task.id)).toHaveLength(attempt);
          expect(runs.latestForTask(task.id)?.launchedAt).toBeInstanceOf(Date);
        },
        { timeout: 2000 },
      );
      const crashed = runs.latestForTask(task.id);
      herdr.exitAgent(crashed?.herdrName ?? "");
      // With backoff 0 the retry is dispatched right away: the Run that crashed is looked at.
      await vi.waitFor(() => expect(runs.get(crashed?.id ?? "")?.result).toBe("failure"));
    }

    await vi.waitFor(() => expect(taskState(db, task.id).state).toBe("needs_human"));
    await vi.waitFor(() =>
      expect(notifications).toEqual([
        expect.objectContaining({
          kind: "retries_exhausted",
          taskId: task.id,
          title: `Retries exhausted in #${task.number}`,
        }),
      ]),
    );
    expect(runs.forTask(task.id).map((r) => r.failureReason?.split(":")[0])).toEqual([
      "agent_exited",
      "agent_exited",
      "agent_exited",
      "agent_exited",
    ]);
  });

  it("when the verification loop is exhausted, needs_human with a notice that identifies the task by its #N", async () => {
    const ctx = setup();
    const { db, project, notifications } = ctx;
    insertTask(db, project.id);
    const task = insertTask(db, project.id, {
      state: "verification",
      subState: "running",
      verificationIteration: 1,
    });
    await startAll(ctx);

    transitionTask(db, {
      taskId: task.id,
      actor: "agent",
      command: { type: "verdict_rework", maxIterations: 1 },
    });

    await vi.waitFor(() =>
      expect(notifications).toEqual([
        expect.objectContaining({
          kind: "verification_exhausted",
          taskId: task.id,
          title: `Verification loop exhausted in #${task.number}`,
        }),
      ]),
    );
    expect(task.number).toBe(2);
  });

  it("during the backoff the task is not dispatched again", async () => {
    const ctx = setup({ config: { retryBackoffMs: 60 * 60_000 } });
    const { db, herdr, orchestrator, project } = ctx;
    const task = insertTask(db, project.id);
    const runs = new RunRepository(db);
    await startAll(ctx);
    await orchestrator.dispatcher.idle();
    herdr.exitAgent(runs.latestForTask(task.id)?.herdrName ?? "");
    await vi.waitFor(() => expect(taskState(db, task.id).subState).toBe("queued"));

    expect((await orchestrator.scheduler.run()).dispatched).toEqual([]);
    expect(runs.forTask(task.id)).toHaveLength(1);
  });

  it("once the backoff has passed, the task is dispatched again", async () => {
    const ctx = setup({ config: { retryBackoffMs: 300 } });
    const { db, herdr, orchestrator, project } = ctx;
    const task = insertTask(db, project.id);
    const runs = new RunRepository(db);
    await startAll(ctx);
    await orchestrator.dispatcher.idle();
    herdr.exitAgent(runs.latestForTask(task.id)?.herdrName ?? "");
    await vi.waitFor(() => expect(taskState(db, task.id).subState).toBe("queued"));
    expect((await orchestrator.scheduler.run()).dispatched).toEqual([]);

    await vi.waitFor(async () => {
      await orchestrator.scheduler.run();
      expect(runs.forTask(task.id)).toHaveLength(2);
    });
    expect(taskState(db, task.id).subState).toBe("running");
  });

  it("on resuming after a timeout, the old Run is closed and the phase is redispatched by itself", async () => {
    const ctx = setup();
    const { db, orchestrator, project } = ctx;
    const task = insertTask(db, project.id);
    const runs = new RunRepository(db);
    await startAll(ctx);
    await orchestrator.dispatcher.idle();
    const first = runs.latestForTask(task.id);
    transitionTask(db, {
      taskId: task.id,
      actor: "system",
      command: { type: "escalate", reason: "phase_timeout" },
    });
    transitionTask(db, { taskId: task.id, actor: "human", command: { type: "resume" } });

    // Without calling the scheduler: the tick is 60 s, so reconciliation wakes it.
    await vi.waitFor(() => {
      expect(runs.get(first?.id ?? "")?.result).toBe("cancelled");
      expect(runs.forTask(task.id)).toHaveLength(2);
    });
  });

  it("if herdr events are lost, reconciliation detects the fallen agent", async () => {
    const ctx = setup({ config: { retryBackoffMs: 60 * 60_000 } });
    const { db, herdr, orchestrator, project } = ctx;
    const task = insertTask(db, project.id);
    await startAll(ctx);
    await orchestrator.dispatcher.idle();
    const run = new RunRepository(db).latestForTask(task.id);
    // The crash event was lost: nobody was watching when the agent left.
    orchestrator.watcher.unwatch(run?.id ?? "");
    herdr.exitAgent(run?.herdrName ?? "");
    // The lifecycle stream is cut: herdr does not say what was lost.
    herdr.dropStreams();

    await vi.waitFor(() =>
      expect(new RunRepository(db).get(run?.id ?? "")?.failureReason).toMatch(/^agent_lost:/),
    );
    expect(taskState(db, task.id)).toEqual({ state: "draft", subState: "queued" });
  });

  it("on restarting the process it observes the live Runs again", async () => {
    const first = setup();
    const task = insertTask(first.db, first.project.id);
    await first.orchestrator.start();
    await first.orchestrator.dispatcher.idle();
    await first.orchestrator.stop();
    const run = new RunRepository(first.db).latestForTask(task.id);

    const second = setup({ db: first.db, herdr: first.herdr });
    await second.orchestrator.start();
    expect(second.orchestrator.watcher.watching()).toEqual([run?.id]);
  });

  it("a canceled task stops its agent and removes its worktree", async () => {
    const ctx = setup();
    const { db, herdr, orchestrator, project } = ctx;
    const task = insertTask(db, project.id);
    await startAll(ctx);
    await orchestrator.dispatcher.idle();
    const run = new RunRepository(db).latestForTask(task.id);

    transitionTask(db, { taskId: task.id, actor: "human", command: { type: "cancel" } });

    await vi.waitFor(async () => {
      expect(await herdr.getAgent(run?.herdrName ?? "")).toBeUndefined();
      const row = db.$client
        .prepare("select worktree_path as p from tasks where id = ?")
        .get(task.id) as { p: string | null };
      expect(row.p).toBeNull();
    });
    expect(new RunRepository(db).get(run?.id ?? "")?.result).toBe("cancelled");
  });
});

describe("Orchestrator: questions", () => {
  const taskState = (db: ReturnType<typeof migratedDatabase>, id: string) =>
    db.$client.prepare("select state, sub_state as subState from tasks where id = ?").get(id) as {
      state: string;
      subState: string | null;
    };

  async function startAll(ctx: ReturnType<typeof setup>) {
    await ctx.orchestrator.start();
    await ctx.publisher.start();
    cleanups.push(() => ctx.publisher.stop());
  }

  /** Dispatches the task and does what ask_human does: waiting_human and the Question, in a transaction. */
  async function asked(ctx: ReturnType<typeof setup>) {
    const task = insertTask(ctx.db, ctx.project.id);
    await startAll(ctx);
    await ctx.orchestrator.dispatcher.idle();
    const run = new RunRepository(ctx.db).latestForTask(task.id);
    if (!run?.herdrName) throw new Error("sin Run");
    const question = ctx.db.transaction((tx) => {
      const moved = applyTransition(tx, {
        taskId: task.id,
        actor: "agent",
        command: { type: "ask_human" },
      });
      if (!moved.ok) throw new Error(moved.error.message);
      return createQuestion(tx, { taskId: task.id, runId: run.id, question: "¿Borro la tabla?" });
    });
    return { task, run, name: run.herdrName, question };
  }

  it("a question still open after the deadline is notified only once", async () => {
    const ctx = setup({ escalationDelayMs: 100 });
    const { question } = await asked(ctx);

    await vi.waitFor(() =>
      expect(ctx.notifications.map((n) => n.id)).toContain(`question:${question.id}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ctx.notifications.filter((n) => n.kind === "question_open")).toHaveLength(1);
  });

  it("answering it in time does not notify and the answer reaches the live pane", async () => {
    const ctx = setup({ escalationDelayMs: 400 });
    const { task, name, question } = await asked(ctx);
    // The outbox builds the notice when it sees the transition.
    await vi.waitFor(() => expect(ctx.escalator.pending()).toEqual([`question:${question.id}`]));

    const result = await ctx.orchestrator.questions.answer(question.id, { answer: "Sí, bórrala" });

    expect(result).toMatchObject({ ok: true, delivery: "pane" });
    expect(await ctx.herdr.readAgent({ name })).toContain("Sí, bórrala");
    expect(taskState(ctx.db, task.id)).toEqual({ state: "draft", subState: "running" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ctx.notifications).toEqual([]);
  });

  it("with the agent dead, the answer redispatches the phase in a new Run", async () => {
    const ctx = setup();
    const { db, orchestrator, herdr } = ctx;
    const { task, run, name, question } = await asked(ctx);
    herdr.exitAgent(name);

    const result = await orchestrator.questions.answer(question.id, { answer: "Sí" });
    expect(result).toMatchObject({ ok: true, delivery: "new_run" });

    // Sin llamar al scheduler: la respuesta lo despierta, no el tick de 60 s.
    const runs = new RunRepository(db);
    await vi.waitFor(() => expect(runs.forTask(task.id)).toHaveLength(2));
    await orchestrator.dispatcher.idle();
    expect(runs.get(run.id)?.result).toBe("cancelled");
    const next = runs.latestForTask(task.id);
    expect(next?.id).not.toBe(run.id);
    expect(taskState(db, task.id)).toEqual({ state: "draft", subState: "running" });
    expect(new QuestionRepository(db).get(question.id)).toMatchObject({
      status: "answered",
      answer: "Sí",
    });
  });

  it("canceling the task with the open question cancels the question and its notice", async () => {
    const ctx = setup({ escalationDelayMs: 400 });
    const { db } = ctx;
    const { task, question } = await asked(ctx);
    await vi.waitFor(() => expect(ctx.escalator.pending()).toEqual([`question:${question.id}`]));

    transitionTask(db, { taskId: task.id, actor: "human", command: { type: "cancel" } });

    await vi.waitFor(() =>
      expect(new QuestionRepository(db).get(question.id)?.status).toBe("cancelled"),
    );
    expect(ctx.escalator.pending()).toEqual([]);
    expect((await ctx.orchestrator.questions.answer(question.id, { answer: "tarde" })).ok).toBe(
      false,
    );
  });

  it("on restart it re-arms the notice of the open questions", async () => {
    const first = setup();
    const { question } = await asked(first);
    await first.orchestrator.stop();

    const second = setup({ db: first.db, herdr: first.herdr, escalationDelayMs: 50 });
    await second.orchestrator.start();

    await vi.waitFor(() =>
      expect(second.notifications.map((n) => n.id)).toContain(`question:${question.id}`),
    );
  });
});
