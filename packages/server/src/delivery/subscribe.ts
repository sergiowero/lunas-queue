// Starts the delivery when the verifier records a pass (verification.verdict_recorded,
// ADR uw-23-verificacion and uw-26-entrega).
import { VERDICT_RECORDED, VerdictRecordedPayload } from "@lunasq/schemas";
import type { OutboxPublisher } from "../outbox/publisher.ts";
import type { DeliveryService } from "./service.ts";

export interface SubscribeDeliveryOptions {
  publisher: OutboxPublisher;
  delivery: Pick<DeliveryService, "deliver">;
  onError?: (error: Error, taskId: string) => void;
}

/**
 * Subscribes the delivery to the outbox and returns the function to unsubscribe. It does not wait for it to finish:
 * the suite, the hooks and the push can take minutes and must not hold up the other
 * subscribers. Delivery is at least once, so `deliver` is idempotent; if the process
 * crashes halfway, `DeliveryService.recover` resumes on start.
 */
export function subscribeDelivery(opts: SubscribeDeliveryOptions): () => void {
  const onError = opts.onError ?? defaultError;
  return opts.publisher.subscribe(VERDICT_RECORDED, (message) => {
    const parsed = VerdictRecordedPayload.safeParse(message.payload);
    const { taskId } = message;
    if (!parsed.success || parsed.data.verdict !== "pass" || taskId === null) return;
    opts.delivery
      .deliver(taskId)
      .catch((error: unknown) =>
        onError(error instanceof Error ? error : new Error(String(error)), taskId),
      );
  });
}

function defaultError(error: Error, taskId: string) {
  console.error(`entrega de ${taskId}:`, error);
}
