import { appendEvent, closeRun } from "@lunasq/db";
import { insertProject, insertRun, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { RUN_FAILED } from "@lunasq/schemas";
import { describe, expect, it, vi } from "vitest";
import { OutboxPublisher } from "../outbox/publisher.ts";
import { subscribeOnFailureHooks } from "./on-failure.ts";
import type { HookPointResult } from "./service.ts";

function setup() {
  const db = migratedDatabase();
  const task = insertTask(db, insertProject(db).id, { state: "in_progress", subState: "running" });
  const run = insertRun(db, task.id, { phase: "implement" });
  const publisher = new OutboxPublisher({ db, onError: () => {} });
  const hooks = vi.fn(async () => ({}) as HookPointResult);
  return { db, task, run, publisher, hooks };
}

describe("subscribeOnFailureHooks", () => {
  it("a Run closed as failure runs the task's on_failure hooks with the Run id and the reason", async () => {
    const { db, task, run, publisher, hooks } = setup();
    subscribeOnFailureHooks({ publisher, hooks: { run: hooks } });

    closeRun(db, run.id, { result: "failure", failureReason: "pane died" });
    await publisher.drain();

    expect(hooks).toHaveBeenCalledOnce();
    expect(hooks).toHaveBeenCalledWith({
      taskId: task.id,
      point: "on_failure",
      runId: run.id,
      phaseResult: "pane died",
    });
  });

  it("a Run closed as success or cancelled does not run them; unsubscribed, neither", async () => {
    const { db, task, run, publisher, hooks } = setup();
    const unsubscribe = subscribeOnFailureHooks({ publisher, hooks: { run: hooks } });

    closeRun(db, run.id, { result: "cancelled", failureReason: "hook_blocked" });
    await publisher.drain();
    unsubscribe();
    appendEvent(
      db,
      {
        taskId: task.id,
        type: RUN_FAILED,
        actor: "system",
        payload: { runId: run.id, phase: "implement", reason: "late" },
      },
      { publish: true },
    );
    await publisher.drain();

    expect(hooks).not.toHaveBeenCalled();
  });

  it("an invalid payload is ignored", async () => {
    const { db, task, publisher, hooks } = setup();
    subscribeOnFailureHooks({ publisher, hooks: { run: hooks } });

    appendEvent(
      db,
      { taskId: task.id, type: RUN_FAILED, actor: "system", payload: { nope: true } },
      { publish: true },
    );
    await publisher.drain();

    expect(hooks).not.toHaveBeenCalled();
  });

  it("a failure of the hooks is reported without holding back the publisher", async () => {
    const { db, task, run, publisher, hooks } = setup();
    hooks.mockRejectedValue(new Error("no worktree"));
    const onError = vi.fn();
    subscribeOnFailureHooks({ publisher, hooks: { run: hooks }, onError });

    closeRun(db, run.id, { result: "failure", failureReason: "x" });
    expect(await publisher.drain()).toBe(1);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error), task.id));
  });

  it("does not wait for the hooks to finish", async () => {
    const { db, run, publisher, hooks } = setup();
    hooks.mockReturnValue(new Promise(() => {}));
    subscribeOnFailureHooks({ publisher, hooks: { run: hooks } });

    closeRun(db, run.id, { result: "failure", failureReason: "x" });

    expect(await publisher.drain()).toBe(1);
  });
});
