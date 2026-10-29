// Publicador en proceso del outbox (docs/design.md §Componentes, ADR 0011). Lee los pendientes
// en orden de escritura, los entrega a los suscriptores (scheduler, dispatcher) y los marca.
// Entrega al menos una vez: si el proceso cae entre entregar y marcar, el mensaje se repite al
// arrancar, así que los suscriptores deben ser idempotentes.
import {
  type LunasqDatabase,
  listPendingOutbox,
  markOutboxPublished,
  type PendingOutboxEntry,
  recordOutboxFailure,
} from "@lunasq/db";
import type { OutboxMessage } from "@lunasq/schemas";

export const DEFAULT_POLL_INTERVAL_MS = 1000;

export type OutboxHandler = (message: OutboxMessage) => void | Promise<void>;

/** `failed` es el mensaje cuya entrega falló, o null si falló la lectura de la cola. */
export type OutboxErrorHandler = (error: Error, failed: PendingOutboxEntry | null) => void;

export interface OutboxPublisherOptions {
  db: LunasqDatabase;
  onError?: OutboxErrorHandler;
  pollIntervalMs?: number;
  batchSize?: number;
}

export class OutboxPublisher {
  private readonly db: LunasqDatabase;
  private readonly onError: OutboxErrorHandler;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly handlers = new Map<string, Set<OutboxHandler>>();
  private running: Promise<number> | undefined;
  // Pedido de otra pasada mientras corre un drain: lo confirmado después de su lectura.
  private rerun = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: OutboxPublisherOptions) {
    this.db = opts.db;
    this.onError = opts.onError ?? defaultError;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = opts.batchSize ?? 100;
  }

  /**
   * `topic` es el tipo del evento o `*` para todos. Con al menos un suscriptor registrado, un
   * mensaje cuyo topic no tiene destinatarios se marca publicado; sin ninguno, no se publica nada.
   */
  subscribe(topic: string, handler: OutboxHandler): () => void {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler);
    this.handlers.set(topic, set);
    return () => {
      set.delete(handler);
    };
  }

  /** Entrega lo pendiente y devuelve cuántos mensajes publicó. Una sola pasada a la vez. */
  drain(): Promise<number> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    // Arranca en una microtarea: un handler que llama wake ya ve `running` asignado.
    this.running = Promise.resolve()
      .then(() => this.loop())
      .finally(() => {
        this.running = undefined;
        // Un wake que llegó después de la última lectura de la cola (o un start tras stop).
        if (this.rerun && !this.stopped) this.wake();
      });
    return this.running;
  }

  /** Pide un drain sin esperarlo; para llamar después de confirmar una transición. */
  wake(): void {
    this.drain().catch((error: unknown) => this.report(toError(error), null));
  }

  /** Entrega lo que quedó pendiente (p. ej. de una caída) y arranca el poll periódico. */
  async start(): Promise<void> {
    this.stopped = false;
    if (!this.timer) this.timer = setInterval(() => this.wake(), this.pollIntervalMs);
    await this.drain().catch((error: unknown) => this.report(toError(error), null));
  }

  /** Detiene el poll y espera al drain en curso, que termina después del mensaje actual. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }

  private async loop(): Promise<number> {
    let published = 0;
    // Sin ningún suscriptor no se marca nada: lo pendiente espera a que alguien se suscriba.
    if ([...this.handlers.values()].every((set) => set.size === 0)) {
      this.rerun = false;
      return published;
    }
    do {
      this.rerun = false;
      for (;;) {
        if (this.stopped) return published;
        const batch = listPendingOutbox(this.db, { limit: this.batchSize });
        for (const entry of batch) {
          // Ante un fallo se detiene para no entregar fuera de orden; el siguiente drain reintenta.
          if (!(await this.deliver(entry))) {
            // Sin pasada extra: el reintento espera al siguiente wake o poll, no entra en bucle.
            this.rerun = false;
            return published;
          }
          markOutboxPublished(this.db, entry.message.id);
          published += 1;
          if (this.stopped) return published;
        }
        if (batch.length < this.batchSize) break;
      }
    } while (this.rerun);
    return published;
  }

  private async deliver(entry: PendingOutboxEntry): Promise<boolean> {
    const { message } = entry;
    const targets = [
      ...(this.handlers.get(message.topic) ?? []),
      ...(this.handlers.get("*") ?? []),
    ];
    try {
      for (const handler of targets) await handler(message);
      return true;
    } catch (error) {
      const attempts = recordOutboxFailure(this.db, message.id);
      this.report(toError(error), { message, attempts });
      return false;
    }
  }

  private report(error: Error, failed: PendingOutboxEntry | null): void {
    try {
      this.onError(error, failed);
    } catch {
      // Un onError roto no detiene al publicador.
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultError(error: Error, failed: PendingOutboxEntry | null): void {
  const where = failed ? `mensaje ${failed.message.id} (intento ${failed.attempts})` : "lectura";
  console.error(`[outbox] fallo en ${where}: ${error.message}`);
}
