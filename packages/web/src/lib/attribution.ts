// Which agent profile did, or will do, a piece of work shown in the UI (docs/decisions/agent-profiles.md
// §Appearance). Nothing is stored for it: it is derived from the Runs and from the project's phase
// profiles that the views already load.
import type { EventView, Phase, RunView, Spec, TaskState } from "@lunasq/schemas";
import type { Json } from "./api.ts";

type Run = Json<RunView>;

/** Phase whose agent a task in this state awaits (mirror of the scheduler's rule); null without one. */
export function pendingPhase(state: TaskState): Exclude<Phase, "deliver"> | null {
  if (state === "draft") return "refine";
  if (state === "in_progress") return "implement";
  if (state === "verification") return "verify";
  return null;
}

/**
 * The Run that was open at `at`: started at or before it and not ended before it. With Runs that
 * overlap (they should not: one is open per task) the latest one wins. `phase` restricts the search.
 */
export function runAt(runs: readonly Run[], at: string, phase?: Phase): Run | null {
  const time = Date.parse(at);
  let found: Run | null = null;
  for (const run of runs) {
    if (phase && run.phase !== phase) continue;
    const started = Date.parse(run.startedAt);
    const ended = run.endedAt === null ? Number.POSITIVE_INFINITY : Date.parse(run.endedAt);
    if (started <= time && time <= ended && (!found || started >= Date.parse(found.startedAt))) {
      found = run;
    }
  }
  return found;
}

/** The profile of an event: only events of the agent actor are attributed, to the Run open when they happened. */
export function eventRun(
  runs: readonly Run[],
  event: Pick<Json<EventView>, "actor" | "createdAt">,
) {
  return event.actor === "agent" ? runAt(runs, event.createdAt) : null;
}

/**
 * The Run that authored a spec version created by the agent: the latest refine Run that started at
 * or before the version. A version of the human has no Run.
 */
export function specVersionRun(
  runs: readonly Run[],
  version: Pick<Json<Spec>, "createdBy" | "createdAt">,
): Run | null {
  if (version.createdBy !== "agent") return null;
  const time = Date.parse(version.createdAt);
  let found: Run | null = null;
  for (const run of runs) {
    if (run.phase !== "refine") continue;
    const started = Date.parse(run.startedAt);
    if (started <= time && (!found || started >= Date.parse(found.startedAt))) found = run;
  }
  return found;
}
