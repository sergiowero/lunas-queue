// Tracking of a task's PR (ADR uw-14-adapter-github). The merge poller watches the PR
// on GitHub and records the change in the database; the scheduler reacts to the event (ADR 0014): a merge
// releases the dependents and a close without merge escalates them to needs_human.
import type { ClosedPrState, PrState } from "@lunasq/schemas";

/**
 * Change recorded when observing `observed` with the task at `current`: only open → merged or
 * closed. A merged or closed PR does not go back; a new one is registered with recordPrOpened.
 */
export function prStateChange(current: PrState | null, observed: PrState): ClosedPrState | null {
  if (current !== "open" || observed === "open") return null;
  return observed;
}

export type TrackedPr = { taskId: string; url: string };

export type ObservedPrState = { url: string; state: PrState; at: Date | null };

export interface PrTrackingStore {
  /** Tasks with an open PR: the ones the poller queries. */
  listOpen(): TrackedPr[];
  /** Records an open PR for the task. false if it was already registered that way. */
  recordPrOpened(taskId: string, url: string): boolean;
  /** Records what was observed if it is a valid change of the task's current PR; otherwise, false. */
  recordPrState(taskId: string, observed: ObservedPrState): boolean;
  /**
   * The open PR of a completed task conflicts with the base: it returns it to in_progress so that the
   * implementer integrates the base (ADR pr-en-conflicto). false if the task is not completed or the
   * PR is no longer its own, so repeating it while the PR remains in conflict does nothing.
   */
  recordPrConflict(taskId: string, url: string): boolean;
  /** An open PR of a completed task has failed checks; returns the task to implementation. */
  recordPrCiFailure(taskId: string, url: string, output: string): boolean;
}
