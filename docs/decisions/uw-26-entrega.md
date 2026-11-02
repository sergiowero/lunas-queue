# UW-26 — Delivery phase: rebase, trailers, final suite, push and PR inside the verifier's Run

- Status: accepted
- Date: 2026-10-30
- Unit: UW-26 · Code: `packages/server/src/delivery/`, `packages/domain/src/delivery.ts`, `packages/schemas/src/delivery.ts`, `rebase`, `listCommits`, `addTrailers` and `push` in `packages/adapters/src/git/`, `addLabels` in `packages/adapters/src/github/`, `deliveryConflict` in `TaskContext` (`packages/schemas/src/mcp.ts`), `prUrl` in `PhaseHookInput`, composition in `packages/server/src/runtime/runtime.ts`

## Context

`docs/design.md` (§Delivery) and ADR 0007 fix that delivery has no agent: LunasQ does it while the verifier's Run is still open, and `verdict_pass` is only emitted when the PR exists. ADR uw-23-verificacion leaves the trigger: the event `verification.verdict_recorded` with `verdict: pass`. ADR uw-24-archivo-evidencia requires the verifier's Run to be closed and its section written before the evidence commit and the push. ADR uw-11-gate-tests reserves the gate's `delivery` trigger, and ADR uw-14-adapter-github asks to record the PR with `recordPrOpened` before `verdict_pass`.

UW-26's criterion: a task with a pass ends in a PR with trailers and a risk label.

## Decision

- **Trigger and retries.** `subscribeDelivery` listens to `verification.verdict_recorded` with a pass in the outbox and calls `DeliveryService.deliver(taskId)` without awaiting it (the suite and the hooks can take minutes). `deliver` is idempotent and runs with a lock per task: it ignores a task that is no longer in `verification/running` (`not_delivering`) or without a stored pass (`no_pass_verdict`), and resumes a half‑done delivery. `recover()` walks on startup the tasks in `verification/running` with a stored pass, because the outbox already marked the message as delivered.
- **Delivery order**:
  1. `before_delivery` hook (with the verifier's Run).
  2. Commit of the pending evidence (`EvidenceService.commit`): the closings of earlier Runs leave new sections in `lunasq/tasks/{id}.md`, and if the project tracks it those edits dirty the worktree and the rebase fails.
  3. `fetch` of the base and rebase onto `origin/<base>`.
  4. `LunasQ-Task` and `LunasQ-Run` trailers on each commit of `origin/<base>..HEAD`.
  5. Final suite with `PaneTestGate` and the `delivery` trigger.
  6. Closing of the verifier's Run (`PhaseDispatcher.closeRun`, which closes the pane and writes the evidence section) and `EvidenceService.commit` (idempotent: writes the new section).
  7. Push.
  8. PR (`createPr`, idempotent) and risk label.
  9. `recordPrOpened`.
  10. `after_delivery` hook with the PR's URL and, if it committed, a second push.
  11. `verdict_pass`.

  The Run is closed before the push and not after the transition, as ADR 0007 suggested: otherwise the verifier's section could not travel in the PR. It breaks nothing: the scheduler only dispatches `queued`, the reconciler only looks at open Runs, and a resumed delivery does not close an already closed Run again. The Run is closed with `success`; the reason for an escalation goes as `cancelled` with `failure_reason`, which does not count as a failure for retries.
- **Trailers per commit.** The commits are written by the agent, and nobody put trailers on them. `commitTrailers` (domain) assigns to each commit the task and the implementation Run that was alive when it was written (by the author date, which the rebase does not change); a commit earlier than every Run uses the first one, and without implementation Runs, the verifier's. `GitAdapter.addTrailers` rewrites the commits with `commit-tree` (same tree, same author and date), without an editor or git hooks, and does not repeat a key the commit already carries: the commits of the hooks (`HookService`) keep theirs and repeating the delivery changes nothing. The PR carries `LunasQ-Task` and `LunasQ-Run` (the verifier's) at the end of its description.
- **Git adapter.** `rebase` (returns `up_to_date`, `rebased` or `conflict` with the files; a conflict is aborted, so the worktree is left as it was, and any other failure throws `git_failed`), `listCommits`, `addTrailers` and `push` (`HEAD:refs/heads/<branch>` with `--force-with-lease`: after the rebase the history changes, but it does not overwrite someone else's push). Real and fake satisfy the same contract suite. The fake detects conflicts by paths touched on both sides and, when rebasing, redoes each own commit on the new base with the same paths.
- **Conflict or red suite.** Closing the verifier's Run writes its evidence section and delivery commits it before returning the task, so the worktree is clean for the implementer's rebase. The task goes back to `in_progress` with `delivery_conflict` (without raising the iteration, ADR 0007) in the same transaction as the `delivery.conflict` event (`rebase_conflict` with the files, or `tests_failed` with the tail of the output). `TaskContext.deliveryConflict` gives it to the implementer while there is no later verdict; the `implement-task` skill tells it to integrate the base and fix. Since those returns do not raise the iteration, the cycle has its own cap: with as many conflicts since the last `resume` as `limits.maxVerificationIterations`, delivery escalates. A project without `testCommand` has no green gate and does not deliver either.
- **Escalations.** A `block` hook stops delivery (`blocked`); if `HookService` did not escalate the task, delivery escalates it with `hook_failed`. A failure of the push, of `gh`, of the transition or of any step escalates with the new reason `delivery_failed` (`EscalationReason`), with the error as the note, and closes the Run if it was still open. On resuming, the task goes back to `verification/queued` and is verified again; the new delivery finds the open PR and reuses it.
- **PR.** Title: first line of the intent, up to 72 characters. Body (`prBody`, domain): intent, criteria with their verdict and evidence, risk, reviewers (or the justification of the skipped ones), refuted findings, evidence file path and trailers; trimmed to 60,000 characters. GitHub label `lunasq:risk-low|medium|high`: `GitHubAdapter.addLabels` creates it if the repo does not have it (`gh label create --force`) and applies it with `gh pr edit`. If applying the label fails, the PR is still valid and delivery continues; the risk also stays in the body. `PullRequest.labels` exposes the labels.
- **`verdict_pass`.** The facts come from the handoffs (`deliveryFacts`): the verdict is pass, every criterion of the spec passed and every criterion has at least one test in the last implementation handoff. It goes with `testGatePassed` (the final suite) and `prCreated`.
- **Composition.** `startRuntime` builds `EvidenceService` (passed to the `Orchestrator` and to delivery) and `DeliveryService`, subscribes delivery to the outbox and calls `recover()` on startup without holding up startup. `stop` unsubscribes but does not wait for a delivery in progress: it is idempotent and resumes on startup.

## Consequences

- If `after_delivery` modifies files, `HookService` commits them and delivery does a second push, so they enter the PR (an extra push may restart CI). Changes that do not need the PR's URL are better made in `before_delivery`.
- A push rejected by `--force-with-lease` (someone else wrote to `lunasq/<id>`) escalates the task instead of overwriting that work.
- A PR that a human closed without merge and a later delivery open another PR (`createPr` does not count closed ones) and `recordPrOpened` accepts it because the previous state is `closed`.
- The final suite runs with the project's `testCommand`, like the other gates.
- The evidence commit prior to the rebase also rewrites history (the rebase reapplies it) and carries the trailers, so delivery does not depend on the file having been left untracked.
- The verifier's Run is closed before the PR exists. If the process crashes between the closing and `verdict_pass`, the section is already written and `recover()` completes the delivery.
- UW-29 (pilot) must test delivery against real `git` and `gh`: here only the git adapter's contract runs against real git; `addLabels` against GitHub needs `LUNASQ_GH_SANDBOX_REPO` (`pnpm --filter @lunasq/adapters test:gh`).
