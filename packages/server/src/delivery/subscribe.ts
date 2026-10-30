// Arranca la entrega cuando el verificador registra un pass (verification.verdict_recorded,
// ADR uw-23-verificacion y uw-26-entrega).
import { VERDICT_RECORDED, VerdictRecordedPayload } from "@lunasq/schemas";
import type { OutboxPublisher } from "../outbox/publisher.ts";
import type { DeliveryService } from "./service.ts";

export interface SubscribeDeliveryOptions {
  publisher: OutboxPublisher;
  delivery: Pick<DeliveryService, "deliver">;
  onError?: (error: Error, taskId: string) => void;
}

/**
 * Suscribe la entrega al outbox y devuelve la función para desuscribir. No espera a que termine:
 * la suite, los hooks y el push pueden tardar minutos y no deben frenar a los demás
 * suscriptores. La entrega es al menos una vez, así que `deliver` es idempotente; si el proceso
 * cae a la mitad, `DeliveryService.recover` retoma al arrancar.
 */
export function subscribeDelivery(opts: SubscribeDeliveryOptions): () => void {
  const onError = opts.onError ?? defaultError;
  return opts.publisher.subscribe(VERDICT_RECORDED, (message) => {
    const parsed = VerdictRecordedPayload.safeParse(message.payload);
    if (!parsed.success || parsed.data.verdict !== "pass") return;
    opts.delivery
      .deliver(message.taskId)
      .catch((error: unknown) =>
        onError(error instanceof Error ? error : new Error(String(error)), message.taskId),
      );
  });
}

function defaultError(error: Error, taskId: string) {
  console.error(`entrega de ${taskId}:`, error);
}
