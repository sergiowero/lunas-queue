export { escalationNotification } from "./escalations.ts";
export { type PauseReason, PhaseClock } from "./phase-clock.ts";
export {
  DEFAULT_ORPHAN_WORKTREES_EVERY,
  DEFAULT_RECONCILE_INTERVAL_MS,
  type ReconcileErrorHandler,
  type ReconcileResult,
  Reconciler,
  type ReconcilerOptions,
} from "./reconciler.ts";
export {
  DEFAULT_MAX_NUDGES,
  DEFAULT_NUDGE_GRACE_MS,
  RunWatcher,
  type RunWatcherOptions,
} from "./watcher.ts";
