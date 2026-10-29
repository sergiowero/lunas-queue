// Stream de `events.subscribe` por el socket Unix de herdr (NDJSON). Una conexión por
// suscripción: herdr cierra la conexión si llega otra request por ella. herdr 0.9.5 cierra el
// stream sin aviso cuando el consumidor se atrasa (ADR 0004), así que todo cierre no pedido
// se reporta como `events_lost` y se reconecta con backoff.
import { createConnection, type Socket } from "node:net";
import type { HerdrEvent, HerdrSubscription } from "./types.ts";
import { streamErrorWire, streamEventWire, subscriptionStartedWire, toEvent } from "./wire.ts";

export interface EventStreamOptions {
  socketPath: string;
  subscriptions: Record<string, unknown>[];
  onEvent: (event: HerdrEvent) => void;
  /** Errores del callback del consumidor; nunca deben tumbar el proceso. */
  onError?: (err: unknown) => void;
  backoff?: { initialMs: number; maxMs: number };
}

export class EventStream implements HerdrSubscription {
  private readonly opts: EventStreamOptions;
  private readonly backoff: { initialMs: number; maxMs: number };
  private socket: Socket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private delayMs: number;
  private closed = false;
  /** Evita repetir `events_lost` mientras los reintentos siguen fallando. */
  private lossReported = false;

  constructor(opts: EventStreamOptions) {
    this.opts = opts;
    this.backoff = opts.backoff ?? { initialMs: 100, maxMs: 5_000 };
    this.delayMs = this.backoff.initialMs;
    this.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.destroy();
    });
  }

  /** Corta la conexión actual como si herdr la cerrara. Solo para tests. */
  drop(): void {
    this.socket?.destroy();
  }

  private connect() {
    const socket = createConnection(this.opts.socketPath);
    this.socket = socket;
    let buffer = "";

    socket.on("connect", () => {
      const request = {
        id: "lunasq-events",
        method: "events.subscribe",
        params: { subscriptions: this.opts.subscriptions },
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) this.handleLine(socket, line);
      }
    });
    // `close` siempre sigue a `error`; ahí se decide si reconectar.
    socket.on("error", () => {});
    socket.on("close", () => this.handleClose(socket));
  }

  private handleLine(socket: Socket, line: string) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    if (subscriptionStartedWire.safeParse(json).success) {
      this.delayMs = this.backoff.initialMs;
      this.lossReported = false;
      this.emit({ type: "subscribed" });
      return;
    }
    const error = streamErrorWire.safeParse(json);
    if (error.success) {
      // Rechazo de la suscripción (p. ej. el pane ya no existe): reintentar no lo arregla.
      const { code, message } = error.data.error;
      this.closed = true;
      if (this.timer) clearTimeout(this.timer);
      socket.destroy();
      this.emit({ type: "subscription_failed", code, message });
      return;
    }
    const parsed = streamEventWire.safeParse(json);
    if (!parsed.success) return;
    let event: HerdrEvent | undefined;
    try {
      event = toEvent(parsed.data.event, parsed.data.data);
    } catch {
      // Evento conocido con un payload inesperado: se ignora; la reconciliación lo cubre.
      return;
    }
    if (event) this.emit(event);
  }

  private handleClose(socket: Socket) {
    if (this.closed || socket !== this.socket) return;
    if (!this.lossReported) {
      this.lossReported = true;
      this.emit({ type: "events_lost", reason: "stream closed" });
    }
    this.timer = setTimeout(() => {
      if (!this.closed) this.connect();
    }, this.delayMs);
    this.delayMs = Math.min(this.delayMs * 2, this.backoff.maxMs);
  }

  private emit(event: HerdrEvent) {
    if (this.closed && event.type !== "subscription_failed") return;
    try {
      this.opts.onEvent(event);
    } catch (err) {
      // Se llama desde los handlers del socket: una excepción aquí sería uncaught.
      (this.opts.onError ?? console.error)(err);
    }
  }
}
