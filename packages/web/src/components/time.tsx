// A moment shown relative to now («hace 3 min») with the exact date on hover. One shared ticker
// re-renders every mounted <Time> every 30 s so the text does not go stale.
import { useSyncExternalStore } from "react";
import { formatDate, formatDuration, formatRelative } from "../lib/format.ts";

const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function snapshot() {
  return now;
}

export function Time({
  iso,
  format = (text) => text,
}: {
  iso: string | null;
  /** Wraps the relative text, for labels such as «desde: hace 3 min». */
  format?: (relative: string) => string;
}) {
  // Subscribing re-renders on each tick; formatRelative reads the clock itself.
  useSyncExternalStore(subscribe, snapshot);
  if (!iso) return <>—</>;
  return (
    <time dateTime={iso} title={formatDate(iso)}>
      {format(formatRelative(iso))}
    </time>
  );
}

/** How long something took, or has taken so far while `end` is still null. */
export function Elapsed({ start, end }: { start: string | null; end: string | null }) {
  const tick = useSyncExternalStore(subscribe, snapshot);
  if (!start) return <>—</>;
  const finish = end ? new Date(end).getTime() : Math.max(tick, Date.now());
  return <>{formatDuration(Math.max(0, finish - new Date(start).getTime()))}</>;
}
