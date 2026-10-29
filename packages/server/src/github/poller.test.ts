import { FakeGitHub, GitHubError } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  listEvents,
  TaskPrRepository,
  taskDependencies,
  transitionTask,
} from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import type { DispatchDecision } from "@lunasq/domain";
import {
  TASK_PR_STATE_CHANGED,
  TASK_TRANSITIONED,
  TaskPrStateChangedPayload,
  TaskTransitionedPayload,
} from "@lunasq/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboxPublisher } from "../outbox/publisher.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { PrPoller, type PrPollerOptions } from "./poller.ts";

const stoppables: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((s) => s.stop()));
  vi.useRealTimers();
});

function setup(opts: Partial<PrPollerOptions> = {}) {
  const db = migratedDatabase();
  const project = insertProject(db);
  const github = new FakeGitHub();
  const prs = new TaskPrRepository(db);
  const errors: { error: Error; url: string | undefined }[] = [];
  const poller = new PrPoller({
    db,
    github,
    onError: (error, pr) => errors.push({ error, url: pr?.url }),
    ...opts,
  });
  stoppables.push(poller);
  /** Una tarea entregada con su PR abierto en el fake y registrado en la base. */
  async function delivered(head: string) {
    const task = insertTask(db, project.id, { state: "completed", subState: null });
    const { pr } = await github.createPr({
      cwd: "/repo",
      head,
      base: "main",
      title: head,
      body: "",
    });
    prs.recordPrOpened(task.id, pr.url);
    return { task, url: pr.url };
  }
  return { db, project, github, prs, poller, errors, delivered };
}

const prState = (db: LunasqDatabase, id: string) =>
  (db.$client.prepare("select pr_state from tasks where id = ?").get(id) as { pr_state: string })
    .pr_state;

describe("PrPoller", () => {
  it("registra merges y cierres con la hora de GitHub, una sola vez", async () => {
    const { db, github, poller, delivered } = setup();
    const a = await delivered("lunasq/a");
    const b = await delivered("lunasq/b");
    const c = await delivered("lunasq/c");
    const at = new Date("2026-10-29T17:54:13.000Z");
    github.merge(a.url, at);
    github.close(b.url);

    expect(await poller.poll()).toEqual({ merged: [a.task.id], closed: [b.task.id] });
    expect([prState(db, a.task.id), prState(db, b.task.id), prState(db, c.task.id)]).toEqual([
      "merged",
      "closed",
      "open",
    ]);
    const event = listEvents(db, a.task.id).find((e) => e.type === TASK_PR_STATE_CHANGED);
    expect(TaskPrStateChangedPayload.parse(event?.payload).at).toBe(at.toISOString());

    expect(await poller.poll()).toEqual({ merged: [], closed: [] });
    expect(listEvents(db, a.task.id).filter((e) => e.type === TASK_PR_STATE_CHANGED)).toHaveLength(
      1,
    );
  });

  it("un PR que falla se reporta y no detiene a los demás", async () => {
    const { github, poller, errors, delivered } = setup();
    const roto = await delivered("lunasq/roto");
    const ok = await delivered("lunasq/ok");
    github.failGetPr(roto.url, new GitHubError("timeout", "lento"));
    github.merge(ok.url);
    expect(await poller.poll()).toEqual({ merged: [ok.task.id], closed: [] });
    expect(errors).toEqual([
      { error: expect.objectContaining({ code: "timeout" }), url: roto.url },
    ]);

    github.failGetPr(roto.url, null);
    github.merge(roto.url);
    expect((await poller.poll()).merged).toEqual([roto.task.id]);
  });

  it("despierta al publicador solo cuando registró algo", async () => {
    const { db, github, delivered } = setup();
    const publisher = new OutboxPublisher({ db, onError: () => {} });
    const wake = vi.spyOn(publisher, "wake");
    const poller = new PrPoller({ db, github, publisher, onError: () => {} });
    const pr = await delivered("lunasq/a");
    await poller.poll();
    expect(wake).not.toHaveBeenCalled();
    github.merge(pr.url);
    await poller.poll();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("un poll durante una pasada se une a ella y pide una más", async () => {
    const { github, poller, delivered } = setup();
    await delivered("lunasq/a");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getPr = github.getPr.bind(github);
    const reads = vi.spyOn(github, "getPr").mockImplementation(async (url) => {
      await gate;
      return getPr(url);
    });
    const first = poller.poll();
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    const second = poller.poll();
    expect(second).toBe(first);
    release();
    await first;
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("start hace una pasada y luego consulta en cada intervalo; stop lo detiene", async () => {
    vi.useFakeTimers();
    const { db, github, delivered } = setup();
    const pr = await delivered("lunasq/a");
    const poller = new PrPoller({ db, github, intervalMs: 5_000, onError: () => {} });
    stoppables.push(poller);
    const reads = vi.spyOn(github, "getPr");
    await poller.start();
    expect(reads).toHaveBeenCalledTimes(1);
    github.merge(pr.url);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(prState(db, pr.task.id)).toBe("merged");
    await poller.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("rechaza un intervalo menor a 1 s", () => {
    const { db, github } = setup();
    expect(() => new PrPoller({ db, github, intervalMs: 10 })).toThrow();
  });
});

/** Dispatcher falso: hace el claim (dispatch → running) como lo hará UW-16. */
class FakeDispatcher {
  readonly calls: DispatchDecision[] = [];
  readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  async dispatch(decision: DispatchDecision): Promise<void> {
    this.calls.push(decision);
    const result = transitionTask(this.db, {
      taskId: decision.taskId,
      actor: "system",
      command: { type: "dispatch" },
      expected: decision.expected,
    });
    if (!result.ok) throw new Error(result.error.code);
  }
}

// Criterio de terminado de UW-14: un merge detectado libera a las tareas dependientes.
describe("PrPoller con outbox y scheduler", () => {
  async function wired() {
    const ctx = setup();
    const { db } = ctx;
    const dispatcher = new FakeDispatcher(db);
    const publisher = new OutboxPublisher({ db, onError: () => {}, pollIntervalMs: 60_000 });
    const scheduler = new Scheduler({
      db,
      dispatcher,
      publisher,
      config: { tickIntervalMs: 60_000 },
      onError: () => {},
    });
    const poller = new PrPoller({ db, github: ctx.github, publisher, onError: () => {} });
    stoppables.push(poller, scheduler, publisher);
    const dep = await ctx.delivered("lunasq/dep");
    const dependiente = insertTask(db, ctx.project.id);
    db.insert(taskDependencies).values({ taskId: dependiente.id, dependsOnId: dep.task.id }).run();
    await publisher.start();
    await scheduler.start();
    return { ...ctx, dispatcher, poller, dep, dependiente };
  }

  it("un merge detectado libera a la tarea dependiente", async () => {
    const { github, dispatcher, poller, dep, dependiente } = await wired();
    expect(dispatcher.calls).toEqual([]);

    github.merge(dep.url);
    await poller.poll();
    await vi.waitFor(() =>
      expect(dispatcher.calls.map((d) => [d.taskId, d.phase])).toEqual([
        [dependiente.id, "refine"],
      ]),
    );
  });

  it("un PR cerrado sin merge manda a la dependiente a needs_human", async () => {
    const { db, github, dispatcher, poller, dep, dependiente } = await wired();
    github.close(dep.url);
    await poller.poll();
    await vi.waitFor(() =>
      expect(
        db.$client.prepare("select state from tasks where id = ?").get(dependiente.id),
      ).toEqual({ state: "needs_human" }),
    );
    const event = listEvents(db, dependiente.id).find((e) => e.type === TASK_TRANSITIONED);
    expect(TaskTransitionedPayload.parse(event?.payload)).toMatchObject({
      command: "escalate",
      reason: "dependency_pr_closed",
    });
    expect(dispatcher.calls).toEqual([]);
  });
});
