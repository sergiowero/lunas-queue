// Canal de la UI: reparte notificaciones a las conexiones SSE vivas. Guarda las últimas
// en un buffer para que una reconexión con Last-Event-ID reciba solo lo que no vio.
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
   * Con `lastEventId` reenvía lo publicado después de ese id. Si ya salió del buffer,
   * todo lo que queda es posterior y se reenvía completo.
   */
  subscribe(listener: NotificationListener, opts: { lastEventId?: string } = {}): () => void {
    if (opts.lastEventId !== undefined) {
      const seen = this.buffer.findIndex((n) => n.id === opts.lastEventId);
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
    // Un suscriptor roto (p. ej. una conexión cerrándose) no afecta a los demás.
  }
}
