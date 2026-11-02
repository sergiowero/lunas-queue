// `events.subscribe` stream over herdr's Unix socket (NDJSON). One connection per
// subscription: herdr closes the connection if another request arrives on it. herdr 0.9.5 closes the
// stream without notice when the consumer falls behind (ADR 0004), so every close not requested
// is reported as `events_lost` and reconnected with backoff.
import { createConnection, type Socket } from "node:net";
import type { HerdrEvent, HerdrSubscription } from "./types.ts";
import { streamErrorWire, streamEventWire, subscriptionStartedWire, toEvent } from "./wire.ts";

export interface EventStreamOptions {
  socketPath: string;
  subscriptions: Record<string, unknown>[];
  onEvent: (event: HerdrEvent) => void;
  /** Errors from the consumer's callback; they must never bring down the process. */
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
  /** Avoids repeating `events_lost` while the retries keep failing. */
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

  /** Cuts the current connection as if herdr closed it. Tests only. */
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
    // `close` always follows `error`; that is where it is decided whether to reconnect.
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
      // Subscription rejection (e.g. the pane no longer exists): retrying does not fix it.
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
      // Known event with an unexpected payload: it is ignored; reconciliation covers it.
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
      // Called from the socket handlers: an exception here would be uncaught.
      (this.opts.onError ?? console.error)(err);
    }
  }
}
