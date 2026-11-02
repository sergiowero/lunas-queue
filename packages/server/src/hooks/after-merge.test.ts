import { appendEvent } from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { TASK_PR_STATE_CHANGED } from "@lunasq/schemas";
import { describe, expect, it, vi } from "vitest";
import { OutboxPublisher } from "../outbox/publisher.ts";
import { subscribeAfterMergeHooks } from "./after-merge.ts";
import type { HookPointResult } from "./service.ts";

const url = "https://github.com/o/r/pull/7";

function setup() {
  const db = migratedDatabase();
  const task = insertTask(db, insertProject(db).id);
  const publisher = new OutboxPublisher({ db, onError: () => {} });
  const run = vi.fn(async () => ({}) as HookPointResult);
  const prChanged = (to: "merged" | "closed") =>
    appendEvent(
      db,
      {
        taskId: task.id,
        type: TASK_PR_STATE_CHANGED,
        actor: "system",
        payload: { url, from: "open", to, at: null },
      },
      { publish: true },
    );
  return { task, publisher, run, prChanged };
}

describe("subscribeAfterMergeHooks", () => {
  it("a recorded merge runs the task's after_merge hooks with the PR URL", async () => {
    const { task, publisher, run, prChanged } = setup();
    subscribeAfterMergeHooks({ publisher, hooks: { run } });

    prChanged("merged");
    await publisher.drain();

    expect(run).toHaveBeenCalledWith({ taskId: task.id, point: "after_merge", prUrl: url });
  });

  it("a PR closed without merge does not run them; unsubscribed, neither", async () => {
    const { publisher, run, prChanged } = setup();
    const unsubscribe = subscribeAfterMergeHooks({ publisher, hooks: { run } });

    prChanged("closed");
    await publisher.drain();
    unsubscribe();
    prChanged("merged");
    await publisher.drain();

    expect(run).not.toHaveBeenCalled();
  });

  it("a failure of the hooks is reported without holding back the publisher", async () => {
    const { task, publisher, run, prChanged } = setup();
    run.mockRejectedValue(new Error("sin worktree"));
    const onError = vi.fn();
    subscribeAfterMergeHooks({ publisher, hooks: { run }, onError });

    prChanged("merged");
    expect(await publisher.drain()).toBe(1);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error), task.id));
  });
});
