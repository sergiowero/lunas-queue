// Fires the on_failure hooks when a Run closes as failure (run.failed, ADR uw-10-hooks). The event is
// appended by `closeRun` in the transaction that closes the Run, so it covers report_failure, the dispatcher's
// failRun (launch error, watcher, reconciler) and providers_unavailable alike.
import { RUN_FAILED, RunFailedPayload } from "@lunasq/schemas";
import type { OutboxPublisher } from "../outbox/publisher.ts";
import type { HookService } from "./service.ts";

export interface OnFailureHooksOptions {
  publisher: OutboxPublisher;
  hooks: Pick<HookService, "run">;
  onError?: (error: Error, taskId: string) => void;
}

/**
 * Subscribes the on_failure hooks to the outbox and returns the function to unsubscribe. It does not wait
 * for them: collecting logs can take a while and must not hold back the other subscribers. Delivery is at
 * least once, so the hooks must be idempotent. A blocked on_failure is only recorded: it never escalates.
 */
export function subscribeOnFailureHooks(opts: OnFailureHooksOptions): () => void {
  const onError = opts.onError ?? defaultError;
  return opts.publisher.subscribe(RUN_FAILED, (message) => {
    const parsed = RunFailedPayload.safeParse(message.payload);
    const { taskId } = message;
    if (!parsed.success || taskId === null) return;
    opts.hooks
      .run({
        taskId,
        point: "on_failure",
        runId: parsed.data.runId,
        phaseResult: parsed.data.reason,
      })
      .catch((error: unknown) =>
        onError(error instanceof Error ? error : new Error(String(error)), taskId),
      );
  });
}

function defaultError(error: Error, taskId: string) {
  console.error(`hooks on_failure of ${taskId}:`, error);
}
