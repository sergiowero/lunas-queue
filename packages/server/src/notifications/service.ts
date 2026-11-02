// Single point to notify the human: deduplicates by id and delivers through each channel
// (herdr toast and SSE to the UI). A channel that fails does not prevent the others.
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
  // In memory (ADR 0009): after a restart a notification may repeat once.
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
    // It is marked before waiting for the channels so a concurrent call does not duplicate.
    this.sent.add(notification.id);
    const results = await Promise.all(
      this.channels.map(async (channel) => {
        try {
          await channel.deliver(notification);
          return true;
        } catch (error) {
          this.onChannelError(channel.name, toError(error), notification);
          return false;
        }
      }),
    );
    // If no channel delivered, the id is released so a later notice retries.
    if (!results.includes(true)) {
      this.sent.delete(notification.id);
      return { delivered: false };
    }
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
      // With `[ui.toast] delivery = "off"` (herdr's default) nothing is shown (ADR 0004).
      if (!res.shown)
        throw new Error(`herdr did not show the notification: ${res.reason ?? "no reason"}`);
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
  console.warn(
    `[notifications] channel ${channel} failed for ${notification.id}: ${error.message}`,
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
