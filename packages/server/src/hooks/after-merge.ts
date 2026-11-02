// Fires the after_merge hooks when the poller records the merge of a task's PR
// (task.pr_state_changed con to = merged, ADR uw-14-adapter-github).
import { TASK_PR_STATE_CHANGED, TaskPrStateChangedPayload } from "@lunasq/schemas";
import type { OutboxPublisher } from "../outbox/publisher.ts";
import type { HookService } from "./service.ts";

export interface AfterMergeHooksOptions {
  publisher: OutboxPublisher;
  hooks: Pick<HookService, "run">;
  onError?: (error: Error, taskId: string) => void;
}

/**
 * Subscribes the after_merge hooks to the outbox and returns the function to unsubscribe. It does not wait
 * for them to finish: a deploy can take minutes and must not hold back delivery to the other
 * subscribers. Delivery is at least once, so an after_merge can repeat: the hooks
 * must be idempotent (docs/design.md §Per-phase hooks).
 */
export function subscribeAfterMergeHooks(opts: AfterMergeHooksOptions): () => void {
  const onError = opts.onError ?? defaultError;
  return opts.publisher.subscribe(TASK_PR_STATE_CHANGED, (message) => {
    const parsed = TaskPrStateChangedPayload.safeParse(message.payload);
    const { taskId } = message;
    if (!parsed.success || parsed.data.to !== "merged" || taskId === null) return;
    opts.hooks
      .run({ taskId, point: "after_merge", prUrl: parsed.data.url })
      .catch((error: unknown) =>
        onError(error instanceof Error ? error : new Error(String(error)), taskId),
      );
  });
}

function defaultError(error: Error, taskId: string) {
  console.error(`hooks after_merge de ${taskId}:`, error);
}
