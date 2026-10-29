import {
  type LunasqDatabase,
  listEvents,
  SchedulerStateRepository,
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
});

/** Dispatcher falso: hace el claim (dispatch → running) como lo hará UW-16. */
class FakeDispatcher {
  readonly calls: DispatchDecision[] = [];
  readonly db: LunasqDatabase;
  reject = new Set<string>();
  gate: Promise<void> | undefined;
  /** Agentes vivos vistos al momento de cada claim. */
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
  it("despacha el ready set en orden de score con la fase de cada tarea", async () => {
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

  it("en pasadas sucesivas nunca excede los límites", async () => {
    const { db, project, dispatcher, scheduler } = setup({ config: { globalConcurrency: 3 } });
    const ids = Array.from({ length: 8 }, () => insertTask(db, project.id).id);
    await scheduler.run();
    await scheduler.run();
    expect(live(db)).toBe(3);
    // Un agente termina su fase: la tarea pasa a refined y libera el slot.
    const [first] = dispatcher.calls;
    if (!first) throw new Error("sin despacho");
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

  it("respeta el límite del proyecto", async () => {
    const { db, dispatcher, scheduler } = setup();
    const limitado = insertProject(db, { limits: { concurrency: 1 } });
    const otro = insertProject(db);
    insertTask(db, limitado.id, { priority: 900 });
    insertTask(db, limitado.id, { priority: 800 });
    const libre = insertTask(db, otro.id, { priority: 1 });
    await scheduler.run();
    expect(dispatcher.calls.map((d) => d.projectId)).toEqual([limitado.id, libre.projectId]);
  });

  it("un despacho rechazado se reporta y no detiene la pasada", async () => {
    const { db, project, dispatcher, scheduler, errors } = setup();
    const a = insertTask(db, project.id, { priority: 900 });
    const b = insertTask(db, project.id, { priority: 100 });
    dispatcher.reject.add(a.id);
    const result = await scheduler.run();
    expect(result.dispatched).toEqual([b.id]);
    expect(errors.map((e) => e.message)).toEqual([`claim perdido ${a.id}`]);
  });

  it("agrupa los pedidos que llegan durante una pasada en una pasada más", async () => {
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

  it("escala a los dependientes de una dependencia cancelada, una sola vez", async () => {
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

  it("reacciona a los eventos del outbox", async () => {
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

  it("el tick recoge lo que no pasó por el outbox y stop lo detiene", async () => {
    const { db, project, dispatcher, scheduler } = setup({ config: { tickIntervalMs: 10 } });
    await scheduler.start();
    insertTask(db, project.id);
    await vi.waitFor(() => expect(dispatcher.calls).toHaveLength(1));
    await scheduler.stop();
    insertTask(db, project.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("stop espera la pasada en curso y no despacha lo que quedaba", async () => {
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

  it("un fallo al leer el estado se reporta en wake", async () => {
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
