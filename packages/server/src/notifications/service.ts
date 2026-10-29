// Punto único para avisar al humano: deduplica por id y entrega por cada canal
// (toast de herdr y SSE hacia la UI). Un canal que falla no impide a los demás.
import type { HerdrAdapter } from "@lunasq/adapters";
import { Notification } from "@lunasq/schemas";
import type { NotificationHub } from "./hub.ts";

export interface NotificationChannel {
  readonly name: string;
  deliver(notification: Notification): Promise<void>;
}

export type ChannelErrorHandler = (
  channel: string,
  error: Error,
  notification: Notification,
) => void;

export class NotificationService {
  private readonly channels: readonly NotificationChannel[];
  private readonly onChannelError: ChannelErrorHandler;
  // En memoria (ADR 0007): tras un reinicio una notificación puede repetirse una vez.
  private readonly sent = new Set<string>();

  constructor(opts: {
    channels: readonly NotificationChannel[];
    onChannelError?: ChannelErrorHandler;
  }) {
    this.channels = opts.channels;
    this.onChannelError = opts.onChannelError ?? defaultChannelError;
  }

  async notify(input: Notification): Promise<{ delivered: boolean }> {
    const notification = Notification.parse(input);
    if (this.sent.has(notification.id)) return { delivered: false };
    // Se marca antes de esperar a los canales para que una llamada concurrente no duplique.
    this.sent.add(notification.id);
    await Promise.all(
      this.channels.map(async (channel) => {
        try {
          await channel.deliver(notification);
        } catch (error) {
          this.onChannelError(channel.name, toError(error), notification);
        }
      }),
    );
    return { delivered: true };
  }
}

export function herdrChannel(herdr: Pick<HerdrAdapter, "notify">): NotificationChannel {
  return {
    name: "herdr",
    async deliver(notification) {
      const res = await herdr.notify({
        title: notification.title,
        body: notification.body,
        sound: "request",
      });
      // Con `[ui.toast] delivery = "off"` (default de herdr) no se muestra nada (ADR 0004).
      if (!res.shown)
        throw new Error(`herdr no mostró la notificación: ${res.reason ?? "sin motivo"}`);
    },
  };
}

export function hubChannel(hub: NotificationHub): NotificationChannel {
  return {
    name: "ui",
    async deliver(notification) {
      hub.publish(notification);
    },
  };
}

function defaultChannelError(channel: string, error: Error, notification: Notification): void {
  console.warn(`[notificaciones] canal ${channel} falló para ${notification.id}: ${error.message}`);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
