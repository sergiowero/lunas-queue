import type { HerdrAdapter } from "@lunasq/adapters";
import { Escalator } from "./escalator.ts";
import { NotificationHub } from "./hub.ts";
import {
  type ChannelErrorHandler,
  herdrChannel,
  hubChannel,
  NotificationService,
} from "./service.ts";
import { notificationRoutes } from "./sse.ts";

export { ESCALATION_DELAY_MS, Escalator, type PendingNotification } from "./escalator.ts";
export { NotificationHub, type NotificationListener } from "./hub.ts";
export {
  type ChannelErrorHandler,
  herdrChannel,
  hubChannel,
  type NotificationChannel,
  NotificationService,
} from "./service.ts";
export { notificationRoutes } from "./sse.ts";

/** Arma el módulo: herdr y UI como canales, escalador sobre el servicio y rutas SSE. */
export function createNotifications(opts: {
  herdr: Pick<HerdrAdapter, "notify">;
  onChannelError?: ChannelErrorHandler;
}) {
  const hub = new NotificationHub();
  const service = new NotificationService({
    channels: [herdrChannel(opts.herdr), hubChannel(hub)],
    ...(opts.onChannelError ? { onChannelError: opts.onChannelError } : {}),
  });
  const escalator = new Escalator({ notify: (n) => service.notify(n) });
  return { hub, service, escalator, routes: notificationRoutes(hub) };
}
