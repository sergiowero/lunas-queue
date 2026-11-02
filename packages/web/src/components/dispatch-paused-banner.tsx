// Global notice: with every agent provider disabled in Settings, the scheduler does not
// dispatch and tasks wait in queued. It is shown on any page.
import { AgentKind } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";

export function DispatchPausedBanner() {
  const t = useT();
  const settings = useQuery(queries.providerSettings());
  const paused = settings.data !== undefined && AgentKind.options.every((k) => !settings.data[k]);
  // A read error, even with cached data, leaves the state unconfirmed: what was last
  // seen may have changed. Only an already known pause is shown as a pause.
  if (settings.isError && !paused) {
    return (
      <div role="status" className="border-b border-border bg-warning/10 text-sm text-text">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 px-6 py-2">
          <strong>{t.dispatch.unknownTitle}</strong>
          <span>{t.dispatch.unknownBody}</span>
          <Link to="/settings" className="font-medium underline">
            {t.dispatch.goToSettings}
          </Link>
        </div>
      </div>
    );
  }
  if (!paused) return null;
  return (
    <div role="status" className="border-b border-border bg-warning/10 text-sm text-text">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 px-6 py-2">
        <strong>{t.dispatch.pausedTitle}</strong>
        <span>{t.dispatch.pausedBody}</span>
        <Link to="/settings" className="font-medium underline">
          {t.dispatch.goToSettings}
        </Link>
      </div>
    </div>
  );
}
