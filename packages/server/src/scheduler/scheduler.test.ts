import {
  type LunasqDatabase,
  listEvents,
  SchedulerStateRepository,
  SettingsRepository,
  taskDependencies,
  transitionTask,
} from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import type { DispatchDecision } from "@lunasq/domain";
import { TASK_TRANSITIONED, TaskTransitionedPayload } from "@lunasq/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboxPublisher } from "../outbox/publisher.ts";
import { Scheduler, type SchedulerOptions } from "./scheduler.ts";

const stoppables: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((s) => s.stop()));
  vi.useRealTimers();
});

/** Fake dispatcher: does the claim (dispatch → running) as UW-16 will. */
class FakeDispatcher {
  readonly calls: DispatchDecision[] = [];
  readonly db: LunasqDatabase;
  reject = new Set<string>();
  gate: Promise<void> | undefined;
  /** Live agents seen at the time of each claim. */
  readonly liveAtClaim: number[] = [];

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  async dispatch(decision: DispatchDecision): Promise<void> {
    this.calls.push(decision);
    await this.gate;
    if (this.reject.has(decision.taskId)) throw new Error(`claim perdido ${decision.taskId}`);
    const result = transitionTask(this.db, {
      taskId: decision.taskId,
      actor: "system",
      command: { type: "dispatch" },
      expected: decision.expected,
    });
    if (!result.ok) throw new Error(result.error.code);
    this.liveAtClaim.push(live(this.db));
  }
}

function live(db: LunasqDatabase): number {
  const row = db.$client
    .prepare("select count(*) as n from tasks where sub_state in ('running', 'waiting_human')")
    .get() as { n: number };
  return row.n;
}

function setup(opts: Partial<SchedulerOptions> = {}) {
  const db = migratedDatabase();
  const project = insertProject(db);
  const dispatcher = new FakeDispatcher(db);
  const errors: Error[] = [];
  const scheduler = new Scheduler({
    db,
    dispatcher,
    onError: (error) => errors.push(error),
    ...opts,
  });
  stoppables.push(scheduler);
  return { db, project, dispatcher, scheduler, errors };
}

describe("Scheduler", () => {
  it("dispatches the ready set in score order with each task's phase", async () => {
    const { db, project, dispatcher, scheduler } = setup();
    const baja = insertTask(db, project.id, { priority: 100 });
    const alta = insertTask(db, project.id, { priority: 500, state: "in_progress" });
    const result = await scheduler.run();
    expect(dispatcher.calls.map((d) => [d.taskId, d.phase])).toEqual([
      [alta.id, "implement"],
      [baja.id, "refine"],
    ]);
    expect(result.dispatched).toEqual([alta.id, baja.id]);
  });

  it("does not dispatch a paused task and dispatches the one in queued", async () => {
    const { db, project, dispatcher, scheduler, errors } = setup();
    const pausada = insertTask(db, project.id, { priority: 900 });
    const lista = insertTask(db, project.id, { priority: 100 });
    const paused = transitionTask(db, {
      taskId: pausada.id,
      actor: "human",
      command: { type: "pause", deliveryInProgress: false },
    });
    expect(paused.ok).toBe(true);
    const result = await scheduler.run();
    expect(result.dispatched).toEqual([lista.id]);
    expect(dispatcher.calls.map((d) => d.taskId)).toEqual([lista.id]);
    expect(errors).toEqual([]);
  });

  it("a paused one with a closed dependency is neither escalated nor an error", async () => {
    const { db, project, scheduler, errors } = setup();
    const dep = insertTask(db, project.id, { state: "cancelled", subState: null });
    const pausada = insertTask(db, project.id, { state: "paused", subState: null });
    db.insert(taskDependencies).values({ taskId: pausada.id, dependsOnId: dep.id }).run();
    expect((await scheduler.run()).escalated).toEqual([]);
    expect(errors).toEqual([]);
    const row = db.$client.prepare("select state from tasks where id = ?").get(pausada.id);
    expect(row).toEqual({ state: "paused" });
  });

  it("in successive passes it never exceeds the limits", async () => {
    const { db, project, dispatcher, scheduler } = setup({ config: { globalConcurrency: 3 } });
    const ids = Array.from({ length: 8 }, () => insertTask(db, project.id).id);
    await scheduler.run();
    await scheduler.run();
    expect(live(db)).toBe(3);
    // An agent ends its phase: the task moves to refined and frees the slot.
    const [first] = dispatcher.calls;
    if (!first) throw new Error("no dispatch");
    const done = transitionTask(db, {
      taskId: first.taskId,
      actor: "agent",
      command: { type: "submit_spec", specComplete: true },
    });
    expect(done.ok).toBe(true);
    await scheduler.run();
    expect(live(db)).toBe(3);
    expect(dispatcher.calls).toHaveLength(4);
    expect(Math.max(...dispatcher.liveAtClaim)).toBeLessThanOrEqual(3);
    expect(new Set(dispatcher.calls.map((d) => d.taskId)).size).toBe(4);
    expect(ids).toEqual(expect.arrayContaining(dispatcher.calls.map((d) => d.taskId)));
  });

  it("respects the project limit", async () => {
    const { db, dispatcher, scheduler } = setup();
    const limitado = insertProject(db, { limits: { concurrency: 1 } });
    const otro = insertProject(db);
    insertTask(db, limitado.id, { priority: 900 });
    insertTask(db, limitado.id, { priority: 800 });
    const libre = insertTask(db, otro.id, { priority: 1 });
    await scheduler.run();
    expect(dispatcher.calls.map((d) => d.projectId)).toEqual([limitado.id, libre.projectId]);
  });

  it("a rejected dispatch is reported and does not stop the pass", async () => {
    const { db, project, dispatcher, scheduler, errors } = setup();
    const a = insertTask(db, project.id, { priority: 900 });
    const b = insertTask(db, project.id, { priority: 100 });
    dispatcher.reject.add(a.id);
    const result = await scheduler.run();
    expect(result.dispatched).toEqual([b.id]);
    expect(errors.map((e) => e.message)).toEqual([`claim perdido ${a.id}`]);
  });

  it("groups the requests that arrive during a pass into one more pass", async () => {
    const db = migratedDatabase();
    const project = insertProject(db);
    const state = new SchedulerStateRepository(db);
    const reads = vi.spyOn(state, "snapshot");
    const { dispatcher, scheduler } = setup({ db, state });
    insertTask(db, project.id);
    let release = () => {};
    dispatcher.gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = scheduler.run();
    await vi.waitFor(() => expect(dispatcher.calls).toHaveLength(1));
    const second = scheduler.run();
    scheduler.wake();
    release();
    await Promise.all([first, second]);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("a request that arrives when the pass is already exiting is not lost", async () => {
    const db = migratedDatabase();
    const project = insertProject(db);
    const state = new SchedulerStateRepository(db);
    const reads = vi.spyOn(state, "snapshot");
    const { dispatcher, scheduler } = setup({ db, state });
    const first = scheduler.run();
    // The pass has no dispatches: it ends without yielding. The request arrives before the finally.
    await Promise.resolve();
    await Promise.resolve();
    insertTask(db, project.id);
    scheduler.wake();
    await first;
    await vi.waitFor(() => expect(dispatcher.calls).toHaveLength(1));
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("a failure escalating is reported with its task and does not skip the dispatches", async () => {
    const { db, project, dispatcher, scheduler, errors } = setup();
    const dep = insertTask(db, project.id, { state: "cancelled", subState: null });
    const bloqueada = insertTask(db, project.id);
    db.insert(taskDependencies).values({ taskId: bloqueada.id, dependsOnId: dep.id }).run();
    const libre = insertTask(db, project.id);
    // A trigger makes the escalation write fail.
    db.$client.exec(`create trigger romper before update of state on tasks
      when new.state = 'needs_human' begin select raise(abort, 'base rota'); end`);
    const result = await scheduler.run();
    expect(result.escalated).toEqual([]);
    expect(dispatcher.calls.map((d) => d.taskId)).toEqual([libre.id]);
    expect(errors.map((e) => e.message)).toEqual(["base rota"]);
  });

  it("escalates the dependents of a canceled dependency, only once", async () => {
    const { db, project, dispatcher, scheduler } = setup();
    const publisher = new OutboxPublisher({ db, onError: () => {} });
    const wake = vi.spyOn(publisher, "wake");
    const withPublisher = new Scheduler({ db, dispatcher, publisher, onError: () => {} });
    stoppables.push(withPublisher);
    const dep = insertTask(db, project.id, { state: "cancelled", subState: null });
    const task = insertTask(db, project.id);
    db.insert(taskDependencies).values({ taskId: task.id, dependsOnId: dep.id }).run();

    const result = await withPublisher.run();
    expect(result.escalated).toEqual([task.id]);
    expect(wake).toHaveBeenCalled();
    const row = db.$client.prepare("select state from tasks where id = ?").get(task.id);
    expect(row).toEqual({ state: "needs_human" });
    const event = listEvents(db, task.id).find((e) => e.type === TASK_TRANSITIONED);
    expect(TaskTransitionedPayload.parse(event?.payload)).toMatchObject({
      command: "escalate",
      reason: "dependency_pr_closed",
    });
    expect((await scheduler.run()).escalated).toEqual([]);
    expect(dispatcher.calls).toEqual([]);
  });

  it("reacts to the outbox events", async () => {
    const { db, project, dispatcher } = setup();
    const publisher = new OutboxPublisher({ db, onError: () => {}, pollIntervalMs: 60_000 });
    const scheduler = new Scheduler({
      db,
      dispatcher,
      publisher,
      config: { tickIntervalMs: 60_000 },
      onError: () => {},
    });
    stoppables.push(scheduler, publisher);
    const task = insertTask(db, project.id, { state: "refined", subState: null });
    await scheduler.start();
    await publisher.start();
    expect(dispatcher.calls).toEqual([]);

    const approved = transitionTask(db, {
      taskId: task.id,
      actor: "human",
      command: { type: "approve", specApproved: true },
    });
    expect(approved.ok).toBe(true);
    publisher.wake();
    await vi.waitFor(() =>
      expect(dispatcher.calls.map((d) => [d.taskId, d.phase])).toEqual([[task.id, "implement"]]),
    );
  });

  it("with claude and copilot disabled it does not dispatch and the tasks stay in queued", async () => {
    const { db, project, dispatcher, scheduler } = setup();
    const task = insertTask(db, project.id);
    new SettingsRepository(db).saveProviders({ claude: false, copilot: false });
    expect((await scheduler.run()).dispatched).toEqual([]);
    expect(dispatcher.calls).toEqual([]);
    expect(live(db)).toBe(0);
    expect(
      db.$client.prepare("select sub_state from tasks where id = ?").pluck().get(task.id),
    ).toBe("queued");
  });

  it("reads the configuration on each pass and dispatches to the enabled provider", async () => {
    const { db, project, dispatcher, scheduler } = setup();
    const settings = new SettingsRepository(db);
    const task = insertTask(db, project.id);
    settings.saveProviders({ claude: false, copilot: false });
    await scheduler.run();
    expect(dispatcher.calls).toEqual([]);

    settings.saveProviders({ claude: false, copilot: true });
    await scheduler.run();
    expect(dispatcher.calls.map((d) => [d.taskId, d.agentKind])).toEqual([[task.id, "copilot"]]);
  });

  it("settings.updated wakes the scheduler through the outbox", async () => {
    const { db, project, dispatcher } = setup();
    const publisher = new OutboxPublisher({ db, onError: () => {}, pollIntervalMs: 60_000 });
    const scheduler = new Scheduler({
      db,
      dispatcher,
      publisher,
      config: { tickIntervalMs: 60_000 },
      onError: () => {},
    });
    stoppables.push(scheduler, publisher);
    const settings = new SettingsRepository(db);
    settings.saveProviders({ claude: false, copilot: false });
    const task = insertTask(db, project.id);
    await scheduler.start();
    await publisher.start();
    expect(dispatcher.calls).toEqual([]);

    settings.saveProviders({ claude: true, copilot: false });
    publisher.wake();
    await vi.waitFor(() =>
      expect(dispatcher.calls.map((d) => [d.taskId, d.agentKind])).toEqual([[task.id, "claude"]]),
    );
  });

  it("with a saved limit of 1 it dispatches exactly one of three tasks in different projects", async () => {
    const { db, dispatcher, scheduler } = setup();
    for (let i = 0; i < 3; i++) insertTask(db, insertProject(db).id);
    new SettingsRepository(db).saveConcurrency({ globalConcurrency: 1 });
    expect((await scheduler.run()).dispatched).toHaveLength(1);
    expect(dispatcher.calls).toHaveLength(1);
    expect(live(db)).toBe(1);
  });

  it("raising the limit in Settings wakes the scheduler and dispatches the queued tasks", async () => {
    const { db, project, dispatcher } = setup();
    const publisher = new OutboxPublisher({ db, onError: () => {}, pollIntervalMs: 60_000 });
    const scheduler = new Scheduler({
      db,
      dispatcher,
      publisher,
      config: { tickIntervalMs: 60_000 },
      onError: () => {},
    });
    stoppables.push(scheduler, publisher);
    const settings = new SettingsRepository(db);
    settings.saveConcurrency({ globalConcurrency: 1 });
    insertTask(db, project.id);
    insertTask(db, insertProject(db).id);
    insertTask(db, insertProject(db).id);
    await scheduler.start();
    await publisher.start();
    expect(dispatcher.calls).toHaveLength(1);

    settings.saveConcurrency({ globalConcurrency: 3 });
    publisher.wake();
    await vi.waitFor(() => expect(dispatcher.calls).toHaveLength(3));
    expect(live(db)).toBe(3);
  });

  it("lowering the limit does not touch the live agents and does not dispatch until they drop below the limit", async () => {
    const { db, dispatcher, scheduler } = setup();
    const settings = new SettingsRepository(db);
    settings.saveConcurrency({ globalConcurrency: 3 });
    const running = Array.from({ length: 3 }, () =>
      insertTask(db, insertProject(db).id, {
        state: "in_progress",
        subState: "running",
      }),
    );
    const queued = insertTask(db, insertProject(db).id);
    settings.saveConcurrency({ globalConcurrency: 1 });

    expect((await scheduler.run()).dispatched).toEqual([]);
    expect(dispatcher.calls).toEqual([]);
    expect(live(db)).toBe(3);
    for (const task of running) {
      expect(
        db.$client.prepare("select sub_state from tasks where id = ?").pluck().get(task.id),
      ).toBe("running");
    }
    expect(
      db.$client.prepare("select sub_state from tasks where id = ?").pluck().get(queued.id),
    ).toBe("queued");
  });

  it("the tick picks up what did not go through the outbox and stop halts it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { db, project, dispatcher, scheduler } = setup({ config: { tickIntervalMs: 1000 } });
    await scheduler.start();
    insertTask(db, project.id);
    expect(dispatcher.calls).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(dispatcher.calls).toHaveLength(1));
    await scheduler.stop();
    insertTask(db, project.id);
    vi.advanceTimersByTime(5000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("stop waits for the pass in progress and does not dispatch what was left", async () => {
    const { db, project, dispatcher, scheduler } = setup();
    insertTask(db, project.id, { priority: 900 });
    insertTask(db, project.id, { priority: 100 });
    let release = () => {};
    dispatcher.gate = new Promise((resolve) => {
      release = resolve;
    });
    const pass = scheduler.run();
    await vi.waitFor(() => expect(dispatcher.calls).toHaveLength(1));
    const stopped = scheduler.stop();
    release();
    await stopped;
    await pass;
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("a failure reading the state is reported in wake", async () => {
    const db = migratedDatabase();
    const state = new SchedulerStateRepository(db);
    vi.spyOn(state, "snapshot").mockImplementation(() => {
      throw new Error("base caída");
    });
    const { scheduler, errors } = setup({ db, state });
    scheduler.wake();
    await vi.waitFor(() => expect(errors.map((e) => e.message)).toEqual(["base caída"]));
  });
});
