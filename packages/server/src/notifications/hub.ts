// UI channel: distributes notifications to the live SSE connections. It keeps the latest
// in a buffer so a reconnection with Last-Event-ID receives only what it did not see.
import type { Notification } from "@lunasq/schemas";

export type NotificationListener = (notification: Notification) => void;

export class NotificationHub {
  private readonly bufferSize: number;
  private readonly buffer: Notification[] = [];
  private readonly listeners = new Set<NotificationListener>();

  constructor(opts: { bufferSize?: number } = {}) {
    this.bufferSize = opts.bufferSize ?? 100;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  publish(notification: Notification): void {
    this.buffer.push(notification);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const listener of this.listeners) safeCall(listener, notification);
  }

  /**
   * With `lastEventId` it resends what was published after that id. If it already left the buffer,
   * everything remaining is later and is resent in full.
   */
  subscribe(listener: NotificationListener, opts: { lastEventId?: string } = {}): () => void {
    if (opts.lastEventId) {
      const seen = this.buffer.findLastIndex((n) => n.id === opts.lastEventId);
      for (const n of this.buffer.slice(seen + 1)) safeCall(listener, n);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function safeCall(listener: NotificationListener, notification: Notification): void {
  try {
    listener(notification);
  } catch {
    // A broken subscriber (e.g. a closing connection) does not affect the others.
  }
}
