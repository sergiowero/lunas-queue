// Dispara los hooks after_merge cuando el poller registra el merge del PR de una tarea
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
 * Suscribe los hooks after_merge al outbox y devuelve la función para desuscribir. No espera a
 * que terminen: un deploy puede tardar minutos y no debe frenar la entrega a los demás
 * suscriptores. La entrega es al menos una vez, así que un after_merge puede repetirse: los hooks
 * deben ser idempotentes (docs/design.md §Hooks por fase).
 */
export function subscribeAfterMergeHooks(opts: AfterMergeHooksOptions): () => void {
  const onError = opts.onError ?? defaultError;
  return opts.publisher.subscribe(TASK_PR_STATE_CHANGED, (message) => {
    const parsed = TaskPrStateChangedPayload.safeParse(message.payload);
    if (!parsed.success || parsed.data.to !== "merged") return;
    opts.hooks
      .run({ taskId: message.taskId, point: "after_merge", prUrl: parsed.data.url })
      .catch((error: unknown) =>
        onError(error instanceof Error ? error : new Error(String(error)), message.taskId),
      );
  });
}

function defaultError(error: Error, taskId: string) {
  console.error(`hooks after_merge de ${taskId}:`, error);
}
