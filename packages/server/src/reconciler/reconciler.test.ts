import { claimRun, transitionTask } from "@lunasq/db";
import { insertTask } from "@lunasq/db/test-helpers";
import { SchedulerConfig } from "@lunasq/schemas";
import { afterEach, describe, expect, it } from "vitest";
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

describe("Reconciler", () => {
  it("con todo en orden no hace nada, y repetir la pasada tampoco", async () => {
    const h = setup();
    await h.launched();
    const empty = { failed: [], closed: [], watched: [], orphanPanes: [], removedWorktrees: [] };
    expect(await h.reconciler.run()).toEqual(empty);
    expect(await h.reconciler.run()).toEqual(empty);
    expect(h.reconcileErrors).toEqual([]);
  });

  it("un Run lanzado cuyo agente ya no está en herdr se da por fallido y se reintenta", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    // Como tras un reinicio: nadie observaba el Run cuando el agente salió.
    h.watcher.unwatch(run.id);
    h.herdr.exitAgent(name);

    const result = await h.reconciler.run();

    expect(result.failed).toEqual([run.id]);
    expect(h.runs.get(run.id)?.failureReason).toMatch(/^agent_lost:/);
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "queued" });
    expect((await h.reconciler.run()).failed).toEqual([]);
  });

  it("con la tarea en waiting_human no da el Run por fallido aunque falte el agente", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    transitionTask(h.db, { taskId, actor: "agent", command: { type: "ask_human" } });
    h.watcher.unwatch(run.id);
    h.herdr.exitAgent(name);

    expect((await h.reconciler.run()).failed).toEqual([]);
    expect(h.runs.get(run.id)?.endedAt).toBeNull();
  });

  it("vuelve a observar un Run vivo que nadie observa (reinicio)", async () => {
    const h = setup();
    const { run } = await h.launched();
    h.watcher.unwatch(run.id);

    expect((await h.reconciler.run()).watched).toEqual([run.id]);
    expect(h.watcher.watching()).toEqual([run.id]);
    expect((await h.reconciler.run()).watched).toEqual([]);
  });

  it("cierra los panes de agentes de LunasQ sin Run y no toca los ajenos", async () => {
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

  it("tarea cancelada: cierra el Run como cancelled, detiene el agente y remueve el worktree", async () => {
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

  it("un worktree con cambios no se fuerza y el fallo se reporta una sola vez", async () => {
    const h = setup();
    const { taskId } = await h.launched();
    h.herdr.setWorktreeDirty(h.taskRow(taskId).worktreePath ?? "");
    cancel(h.db, taskId);

    await h.reconciler.run();
    await h.reconciler.run();

    expect(h.taskRow(taskId).worktreePath).not.toBeNull();
    expect(h.reconcileErrors.filter((e) => e.subject === taskId)).toHaveLength(1);
  });

  it("needs_human por timeout conserva el Run y el agente; al reanudar se cierra el Run viejo", async () => {
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

  it("no toca el Run del verificador con handoff guardado mientras corre la entrega", async () => {
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

  it("un Run reclamado sin lanzar de una tarea cancelada se cierra y no se lanza", async () => {
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

  it("avisa al cerrar o fallar Runs, para que el scheduler despache ya", async () => {
    let woken = 0;
    const h = setup({ onRunsClosed: () => woken++ });
    const { taskId } = await h.launched();
    await h.reconciler.run();
    expect(woken).toBe(0);
    cancel(h.db, taskId);
    await h.reconciler.run();
    expect(woken).toBe(1);
  });

  it("remueve los worktrees huérfanos de cada proyecto", async () => {
    const h = setup({ orphanWorktreesEvery: 1 });
    const { taskId, run } = await h.launched();
    await h.dispatcher.closeRun(run.id, { result: "success" });
    // La tarea se liberó y olvidó su worktree en la base, pero el checkout sigue en el repo.
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

  it("onMessage pide pasada al cancelar o al mergear", async () => {
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
