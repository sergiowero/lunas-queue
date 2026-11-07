# UW-17 — Signals, nudges, phase timeout, backoff and reconciliation

- Status: accepted
- Date: 2026-10-29
- Unit: UW-17 · Code: `packages/server/src/reconciler/` (`RunWatcher`, `PhaseClock`, `Reconciler`, `escalationNotification`), `packages/server/src/dispatcher/orchestrator.ts`, `packages/domain/src/scheduler.ts` (`retryAt`), `packages/domain/src/dispatch.ts` (`nudgePrompt`, `isAgentName`), `packages/db/src/scheduler-state.ts` (`retry`), `packages/db/src/task-worktrees.ts` (`releasable`), `packages/schemas/src/{scheduler,notification}.ts`

## Context

`docs/design.md` (§Signals and how they are interpreted, §Phase timeout, §Reconciliation loop) fixes the signals table, the 30‑minute timeout with pause, the 3 retries with backoff and the reconciliation with `session.snapshot`. Several ADRs left work for this unit:

- ADR uw-16-dispatcher: implement `RunObserver` and use `failRun` on a crash.
- ADR 0009: call `Escalator.watch`/`resolve` on `blocked`, with a different id for each block.
- ADR 0010: stop the agent of a canceled task.
- ADR 0012 and ADR uw-14-adapter-github: remove the worktree after cancellation or merge, and clean up orphans.
- ADR 0014: do not treat `waiting_human` as a crash.
- ADR 0007: do not treat the delivery interval as a fallen Run.

UW-17's criterion: each simulated failure scenario ends in the expected state and notification.

## Decision

- **`RunWatcher`** implements `RunObserver`. For each launched Run it opens a herdr subscription to its pane, as ADR 0004 asks, and shares a global lifecycle subscription. A Run's signals are serialized with a `KeyedLock`, and before acting each one rereads the Run and the task in the database. This way, a signal that arrives after an MCP tool closed the Run does nothing.
  - **`blocked`**: pauses the clock and calls `Escalator.watch` with id `blocked:<runId>:<n>`. On leaving `blocked`, it calls `resolve` and resumes the clock.
  - **`idle`/`done` with the Run open and the task in `running`**: after a grace period (`nudgeGraceMs`, 15 s by default), it sends a nudge with `nudgePrompt`, up to `maxNudges` times (2 by default). If the agent stops again, `failRun` with `agent_stopped: …`. The grace covers the exit tool that closes the Run just before the agent ends its turn. In `waiting_human` there are no nudges.
  - **`pane_closed`/`pane_exited`** of an observed pane: `failRun` with `agent_exited: …`. The dispatcher calls `unwatch` before closing its own pane, so its own cleanup does not count as a crash. With the task in `waiting_human` the Run stays open (ADR 0014): the answer relaunches (UW-22). A `subscription_failed` only counts as a lost pane with `pane_not_found`; any other code asks to reconcile.
  - **Runs that are neither failed nor escalated:** a closed Run, or one with a stored handoff (the verifier passed and delivery runs with the Run open, ADR 0007). No nudges, no `failRun` and no timeout. After each await the watcher confirms the Run is still observed, because the dispatcher may have called `unwatch` in the meantime.
  - **Expired timeout** (if it expires with the question open before the outbox paused the clock, it stays paused with no budget and escalates when answered): applies `escalate` with `reason: phase_timeout` and `expected` in running, and notifies `phase_timeout` immediately (id `timeout:<runId>`). The agent stays alive and the Run stays open; from then on it is only watched that the pane stays alive.
  - **Event loss**: an `events_lost` on any subscription asks for a reconciliation pass. When a pane's subscription reconnects (`subscribed`), the agent's state is reread.
- **`PhaseClock`**: budget of `phaseTimeoutMs(project, phase)`, which only runs without pause reasons (`blocked`, `waiting_human`). The `waiting_human` pause arrives through the outbox: `RunWatcher.onTransition` aligns the clock with the task's sub‑state. **It lives in memory**: after a restart, the reconciler observes the Run again with the full budget. It never escalates early, but may take up to one more timeout. Persisting the paused time was discarded because it requires new columns and writes on every state change.
- **Retry backoff.** The domain decides it: `retryAt(retry, config)` = end of the last failure + `retryBackoffMs·2^(n‑1)`, capped at `maxRetryBackoffMs`. The defaults are 30 s and 10 min (`SchedulerConfig`). `SchedulerStateRepository` adds to each `queued` task its `retry`: the consecutive failures of the pending phase, with the same `consecutiveFailures` as ADR 0007 (since the last successful Run or `resume`), and the `endedAt` of the last one. `rankReady` does not consider a task ready before `retryAt`, so it does not occupy a slot. The scheduler's tick (30 s) picks it up on expiry. It applies equally to crashes and to `report_failure`. The 3 retries remain those of `run_failed` (ADR 0007): the fourth consecutive failure sends it to needs_human.
- **`Reconciler`**: runs every `intervalMs` (60 s by default), on startup and when the watcher loses events. Passes do not overlap and a request during a pass is grouped into another, as in the scheduler. It reads herdr's snapshot *before* `runs.active()`: this way every agent in the snapshot belongs to an already visible Run. Each Run is reread before correcting it, because the pass's earlier corrections wait for herdr. Per open Run:
  - If the Run has a **stored handoff**, it is not touched: it is the verifier's pass while delivery runs (ADR 0007).
  - **Task in needs_human**: it is respected and, if the agent is alive, observed again.
  - **Task outside the Run's phase** (canceled, resumed after a timeout, in another state): `closeRun` with `result: cancelled` and `failureReason: task_left_phase: …`, which also closes the pane. It also applies to a claimed Run that was not launched: its launch stops at the next step (`RunClosed`).
  - **Live agent not observed**: `watch`.
  - **No agent with the task in running** (confirmed with `getAgent`, in case the snapshot was taken before it started): `failRun` with `agent_lost: …`. In `waiting_human` it is not failed, because the answer relaunches (UW-22).
  - Afterwards it calls `dispatcher.recover()`, which now skips Runs with a launch in progress. It goes after closing the out‑of‑phase Runs, so those are not relaunched.
  - If the pass closed or failed any Run, it wakes the scheduler (`onRunsClosed`): a task resumed after a timeout is redispatched without waiting for the tick.
  - **Orphan panes**: the pane of any agent with a LunasQ name (`isAgentName`) without an open Run is closed; foreign agents are not touched.
  - **Worktrees**: the worktree of each task in `TaskWorktreeRepository.releasable()` is removed, which uses the same rule as `worktreeReleased`: canceled, or completed with the PR merged or with a Result. The removal is forced only for canceled tasks (`worktreeForceRemovable`): uncommitted changes are discarded and the branch is kept; for merged or Result tasks it is not forced. A failure, for example `dirty_worktree` of a merged task, is reported only once. A task with a Run still open waits for another pass, in the sweep too (`cleanupOrphans` receives a `skip` predicate). Every `orphanWorktreesEvery` passes (10 by default) `cleanupOrphans` is called on each project, because that search lists the repo in herdr and may create the project's workspace (ADR 0012).
  - A cancellation or a `resume` (outbox `task.transitioned`), or a merge (`task.pr_state_changed` with `to: merged`), ask for an immediate pass.
- **Resuming after a timeout.** The exit tools require `running` (ADR 0007), so "waiting" means leaving the task in needs_human while the agent is looked at in herdr; that agent can no longer close the phase. On resuming, the task goes back to `queued` and the reconciler closes the old Run as cancelled. The scheduler redispatches the phase on the same worktree, with the code intact.
- **Escalation notifications through the outbox.** `escalationNotification` converts a transition to needs_human into a notice:
  - `retries_exhausted` produces the new kind `retries_exhausted`, with id `retries:<taskId>:<eventId>`;
  - `iterations_exhausted` produces `verification_exhausted`, with id `iterations:<taskId>:<eventId>`.

  This way there is a single place that notifies, whether the escalation comes from the dispatcher or from the LunasQ MCP. The id comes from the event, so the outbox's "at least once" delivery does not duplicate notices (ADR 0009). The phase timeout is notified by the watcher directly.
- **Composition.** `Orchestrator` builds `RunWatcher` (the dispatcher's observer, unless `observer` is passed), `Reconciler` and the outbox subscriptions. If it does not receive `notifications`, it builds the module with herdr as a channel and exposes it in `orchestrator.notifications`, so whoever composes the server mounts the SSE. `start()` reconciles before starting the scheduler. `stop()` stops the reconciliation and the scheduler, waits for the launches and stops observing.

## Consequences

- **Concurrency in needs_human by timeout.** The agent stays alive but the task does not occupy a slot (`Occupancy` counts only `running` and `waiting_human`, ADR 0014). While the human decides, the concurrency limit may be temporarily exceeded. It is accepted in v1; if it bothers, `Occupancy` can count the open Runs.
- **UW-22** answers the questions. If the agent died in `waiting_human`, neither the watcher nor the reconciler fails it: the Run stays open until `answer` moves it: with `agentAlive: false` the task goes to `queued` and the reconciler closes the old Run as cancelled.
- **UW-26** does not need to remove the worktree after the merge: reconciliation does it. If delivery crashes with the verifier's Run open and with a handoff, the reconciler does not touch it; UW-26 must close it or retry it.
- **UW-23** does not have to emit `verification_exhausted`: it arrives through the outbox.
- **Nudges and blocks in memory.** After a restart the nudge counter goes back to 0, and a previous `blocked` is escalated again 1 minute after the restart (with an id that may repeat the previous one; ADR 0009's in‑memory deduplication was also reset).
- **Not tested against real herdr in this unit:** that Claude Code reports `done`/`idle` when it ends the turn and not between tools. If it reports `idle` between tools, the 15 s grace avoids spurious nudges; the pilot (UW-29) calibrates it.
