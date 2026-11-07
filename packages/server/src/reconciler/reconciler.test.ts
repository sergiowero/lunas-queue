import { claimRun, RunRepository, transitionTask } from "@lunasq/db";
import { insertTask } from "@lunasq/db/test-helpers";
import { SchedulerConfig } from "@lunasq/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Reconciler, type ReconcilerOptions } from "./reconciler.ts";
import { harness } from "./test-helpers.ts";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

function setup(opts: Partial<ReconcilerOptions> = {}) {
  const h = harness();
  if (!h.dispatcher) throw new Error("sin dispatcher");
  const errors: { error: Error; subject: string | null }[] = [];
  const reconciler = new Reconciler({
    db: h.db,
    herdr: h.herdr,
    dispatcher: h.dispatcher,
    watcher: h.watcher,
    worktrees: h.worktrees,
    projects: h.projects,
    onError: (error, subject) => errors.push({ error, subject }),
    ...opts,
  });
  stops.push(async () => {
    await reconciler.stop();
    await h.stop();
  });
  return { ...h, dispatcher: h.dispatcher, reconciler, reconcileErrors: errors };
}

function cancel(db: ReturnType<typeof setup>["db"], taskId: string) {
  const res = transitionTask(db, { taskId, actor: "human", command: { type: "cancel" } });
  if (!res.ok) throw new Error(res.error.message);
}

function pause(db: ReturnType<typeof setup>["db"], taskId: string) {
  const res = transitionTask(db, {
    taskId,
    actor: "human",
    command: { type: "pause", deliveryInProgress: false },
  });
  if (!res.ok) throw new Error(res.error.message);
}

describe("Reconciler", () => {
  it("with everything in order it does nothing, and repeating the pass does not either", async () => {
    const h = setup();
    await h.launched();
    const empty = { failed: [], closed: [], watched: [], orphanPanes: [], removedWorktrees: [] };
    expect(await h.reconciler.run()).toEqual(empty);
    expect(await h.reconciler.run()).toEqual(empty);
    expect(h.reconcileErrors).toEqual([]);
  });

  it("a launched Run whose agent is no longer in herdr is given as failed and retried", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    // Like after a restart: nobody was watching the Run when the agent left.
    h.watcher.unwatch(run.id);
    h.herdr.exitAgent(name);

    const result = await h.reconciler.run();

    expect(result.failed).toEqual([run.id]);
    expect(h.runs.get(run.id)?.failureReason).toMatch(/^agent_lost:/);
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "queued" });
    expect((await h.reconciler.run()).failed).toEqual([]);
  });

  it("with the task in waiting_human it does not give the Run as failed even if the agent is missing", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    transitionTask(h.db, { taskId, actor: "agent", command: { type: "ask_human" } });
    h.watcher.unwatch(run.id);
    h.herdr.exitAgent(name);

    expect((await h.reconciler.run()).failed).toEqual([]);
    expect(h.runs.get(run.id)?.endedAt).toBeNull();
  });

  it("watches again a live Run that nobody watches (restart)", async () => {
    const h = setup();
    const { run } = await h.launched();
    h.watcher.unwatch(run.id);

    expect((await h.reconciler.run()).watched).toEqual([run.id]);
    expect(h.watcher.watching()).toEqual([run.id]);
    expect((await h.reconciler.run()).watched).toEqual([]);
  });

  it("closes the panes of LunasQ agents without a Run and does not touch foreign ones", async () => {
    const h = setup();
    const { run } = await h.launched();
    const orphanPane = await h.herdr.splitPane({ paneId: run.herdrPane ?? "" });
    await h.herdr.startAgent({
      name: "t0123456789ab-implement-2",
      kind: "claude",
      paneId: orphanPane.paneId,
    });
    const otherPane = await h.herdr.splitPane({ paneId: run.herdrPane ?? "" });
    await h.herdr.startAgent({ name: "mio", kind: "claude", paneId: otherPane.paneId });

    expect((await h.reconciler.run()).orphanPanes).toEqual([orphanPane.paneId]);
    const names = (await h.herdr.snapshot()).agents.map((a) => a.name).sort();
    expect(names).toEqual([run.herdrName, "mio"].sort());
  });

  it("canceled task: closes the Run as cancelled, stops the agent and removes the worktree", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    expect(h.taskRow(taskId).worktreePath).not.toBeNull();
    cancel(h.db, taskId);

    const result = await h.reconciler.run();

    expect(result.closed).toEqual([run.id]);
    expect(result.removedWorktrees).toEqual([taskId]);
    expect(h.runs.get(run.id)).toMatchObject({ result: "cancelled" });
    expect(h.runs.get(run.id)?.failureReason).toMatch(/^task_left_phase:/);
    expect(await h.herdr.getAgent(name)).toBeUndefined();
    expect(h.taskRow(taskId)).toMatchObject({ state: "cancelled", worktreePath: null });
    expect(await h.reconciler.run()).toMatchObject({ closed: [], removedWorktrees: [] });
  });

  it("canceled task with uncommitted changes: removes the worktree with force and keeps the branch", async () => {
    const h = setup();
    const { taskId } = await h.launched();
    const path = h.taskRow(taskId).worktreePath ?? "";
    h.herdr.setWorktreeDirty(path);
    cancel(h.db, taskId);

    const result = await h.reconciler.run();

    expect(result.removedWorktrees).toEqual([taskId]);
    expect(h.taskRow(taskId).worktreePath).toBeNull();
    expect(h.reconcileErrors).toEqual([]);
    expect(h.herdr.branches(h.project.localPath)).toContain(`lunasq/${taskId}`);
    // Already removed: another pass removes nothing and reports nothing.
    expect(await h.reconciler.run()).toMatchObject({ closed: [], removedWorktrees: [] });
    expect(h.reconcileErrors).toEqual([]);
  });

  it("canceled task whose last Run is still open: the worktree waits for another pass", async () => {
    const h = setup();
    const { taskId, run } = await h.launched();
    h.herdr.setWorktreeDirty(h.taskRow(taskId).worktreePath ?? "");
    cancel(h.db, taskId);
    // The pass sees the task's last Run as still open (a launch that is stopping).
    const open = vi
      .spyOn(RunRepository.prototype, "latestForTask")
      .mockReturnValue({ ...run, endedAt: null });

    const first = await h.reconciler.run();
    expect(first.removedWorktrees).toEqual([]);
    expect(h.taskRow(taskId).worktreePath).not.toBeNull();

    open.mockRestore();
    expect((await h.reconciler.run()).removedWorktrees).toEqual([taskId]);
  });

  it("task completed with its PR merged and uncommitted changes: does not force and reports once", async () => {
    const h = setup();
    const { taskId } = await h.launched();
    const path = h.taskRow(taskId).worktreePath ?? "";
    h.herdr.setWorktreeDirty(path);
    h.db.$client
      .prepare(
        "update tasks set state = 'completed', sub_state = null, pr_state = 'merged' where id = ?",
      )
      .run(taskId);

    const first = await h.reconciler.run();
    await h.reconciler.run();

    expect(first.removedWorktrees).toEqual([]);
    expect(h.taskRow(taskId).worktreePath).toBe(path);
    expect(h.reconcileErrors.filter((e) => e.subject === taskId)).toHaveLength(1);
    expect(h.reconcileErrors[0]?.error).toMatchObject({ code: "dirty_worktree" });
  });

  it("task completed with a Result: closes the Run, stops the agent and removes the worktree", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    h.db.$client
      .prepare(
        "update tasks set state = 'completed', sub_state = null, result_kind = 'research', result = 'hallazgos' where id = ?",
      )
      .run(taskId);

    const result = await h.reconciler.run();

    expect(result.closed).toEqual([run.id]);
    expect(result.removedWorktrees).toEqual([taskId]);
    expect(await h.herdr.getAgent(name)).toBeUndefined();
    expect(h.taskRow(taskId)).toMatchObject({ state: "completed", worktreePath: null });
  });

  it("onMessage requests a pass on delivering a Result", async () => {
    const h = setup();
    const { taskId, run } = await h.launched();
    h.db.$client
      .prepare(
        "update tasks set state = 'completed', sub_state = null, result_kind = 'research', result = 'x' where id = ?",
      )
      .run(taskId);
    h.reconciler.onMessage({
      id: 1,
      eventId: 1,
      topic: "task.transitioned",
      taskId,
      actor: "agent",
      payload: {
        command: "submit_result",
        from: { state: "draft", subState: "running" },
        to: { state: "completed", subState: null },
        verificationIteration: 0,
        note: "research",
      },
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(h.taskRow(taskId).worktreePath).toBeNull());
    expect(h.runs.get(run.id)?.endedAt).not.toBeNull();
  });

  it("paused task: closes the Run as cancelled, stops the agent and keeps the worktree", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    const worktreePath = h.taskRow(taskId).worktreePath;
    expect(worktreePath).not.toBeNull();
    pause(h.db, taskId);

    const result = await h.reconciler.run();

    expect(result.closed).toEqual([run.id]);
    expect(result.removedWorktrees).toEqual([]);
    expect(h.runs.get(run.id)).toMatchObject({ result: "cancelled" });
    expect(h.runs.get(run.id)?.failureReason).toMatch(/^task_left_phase:/);
    expect(await h.herdr.getAgent(name)).toBeUndefined();
    expect(h.taskRow(taskId)).toMatchObject({ state: "paused", worktreePath });
    expect(await h.reconciler.run()).toMatchObject({ closed: [], removedWorktrees: [] });
    expect(h.reconcileErrors).toEqual([]);
  });

  it("onMessage requests a pass on pausing", async () => {
    const h = setup();
    const { taskId, run } = await h.launched();
    pause(h.db, taskId);
    h.reconciler.onMessage({
      id: 1,
      eventId: 1,
      topic: "task.transitioned",
      taskId,
      actor: "human",
      payload: {
        command: "pause",
        from: { state: "draft", subState: "running" },
        to: { state: "paused", subState: null },
        verificationIteration: 0,
      },
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(h.runs.get(run.id)?.result).toBe("cancelled"));
  });

  it("needs_human by timeout keeps the Run and the agent; on resuming the old Run is closed", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    transitionTask(h.db, {
      taskId,
      actor: "system",
      command: { type: "escalate", reason: "phase_timeout" },
    });

    expect((await h.reconciler.run()).closed).toEqual([]);
    expect(await h.herdr.getAgent(name)).toBeDefined();

    transitionTask(h.db, {
      taskId,
      actor: "human",
      command: { type: "resume" },
    });
    expect((await h.reconciler.run()).closed).toEqual([run.id]);
    expect(await h.herdr.getAgent(name)).toBeUndefined();
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "queued" });
  });

  it("does not touch the verifier's Run with a saved handoff while the delivery runs", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    h.runs.recordHandoff(run.id, { verdict: "pass" });
    h.db.$client
      .prepare("update tasks set state = 'completed', sub_state = null where id = ?")
      .run(taskId);
    h.herdr.exitAgent(name);
    h.watcher.unwatch(run.id);

    expect(await h.reconciler.run()).toMatchObject({ closed: [], failed: [] });
    expect(h.runs.get(run.id)?.endedAt).toBeNull();
  });

  it("a claimed Run that never launched of a canceled task is closed and not launched", async () => {
    const h = setup();
    const task = insertTask(h.db, h.project.id);
    const claim = claimRun(h.db, {
      decision: {
        taskId: task.id,
        projectId: h.project.id,
        phase: "refine",
        expected: { state: "draft", subState: "queued" },
      },
      config: SchedulerConfig.parse({}),
      projects: h.projects,
      sessionId: "s-1",
    });
    if (!claim.ok) throw new Error(claim.error.message);
    cancel(h.db, task.id);

    expect((await h.reconciler.run()).closed).toEqual([claim.run.id]);
    await h.dispatcher.idle();
    expect(h.runs.get(claim.run.id)).toMatchObject({ result: "cancelled", launchedAt: null });
    expect((await h.herdr.snapshot()).agents).toEqual([]);
  });

  it("notifies on closing or failing Runs, so the scheduler dispatches right away", async () => {
    let woken = 0;
    const h = setup({ onRunsClosed: () => woken++ });
    const { taskId } = await h.launched();
    await h.reconciler.run();
    expect(woken).toBe(0);
    cancel(h.db, taskId);
    await h.reconciler.run();
    expect(woken).toBe(1);
  });

  it("removes the orphan worktrees of each project", async () => {
    const h = setup({ orphanWorktreesEvery: 1 });
    const { taskId, run } = await h.launched();
    await h.dispatcher.closeRun(run.id, { result: "success" });
    // The task freed itself and forgot its worktree in the database, but the checkout is still in the repo.
    h.db.$client
      .prepare(
        "update tasks set state = 'cancelled', sub_state = null, worktree_path = null where id = ?",
      )
      .run(taskId);
    const before = await h.worktrees.findOrphans(h.project.id);
    expect(before).toHaveLength(1);

    await h.reconciler.run();

    expect(await h.worktrees.findOrphans(h.project.id)).toEqual([]);
  });

  it("onMessage requests a pass on canceling or merging", async () => {
    const h = setup();
    const { taskId, run } = await h.launched();
    cancel(h.db, taskId);
    h.reconciler.onMessage({
      id: 1,
      eventId: 1,
      topic: "task.transitioned",
      taskId,
      actor: "human",
      payload: {
        command: "cancel",
        from: { state: "draft", subState: "running" },
        to: { state: "cancelled", subState: null },
        verificationIteration: 0,
      },
      createdAt: new Date().toISOString(),
    });
    await h.reconciler.run();
    expect(h.runs.get(run.id)?.result).toBe("cancelled");
  });
});
