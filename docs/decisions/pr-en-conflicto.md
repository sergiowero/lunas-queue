# PR in conflict or with failed CI after delivery, and reviewer selection

- Status: accepted
- Date: 2026-10-30
- Code: `delivery_conflict` in `packages/domain/src/state-machine.ts`, `PrTrackingStore.recordPrConflict` (`packages/domain/src/pull-requests.ts`, `packages/db/src/task-prs.ts`), `PullRequest.mergeable` in `packages/adapters/src/github/`, `PrPoller` in `packages/server/src/github/poller.ts`, `DeliveryConflictReason` in `packages/schemas/src/delivery.ts`, `assets/skills/verify-task/SKILL.md`, `assets/agents/lunasq/`

## Context

Delivery (ADR uw-26-entrega) rebases onto the base before opening the PR, but afterwards the task stays in Completed and nobody looks at the branch again. With several tasks in parallel, merging one PR leaves the others in conflict with the base, and LunasQ did not detect it: the human had to resolve them by hand.

Separately, the `verify-task` skill and the reviewers' descriptions said "launch the 4 reviewers" and "launch it in every verification", so the approver almost always launched all four, even though the design says it decides which apply.

## Decision

- **Detection.** `GitHubAdapter.getPr` reads `mergeable` and `checks.status` from `gh pr view`. The poller sends back to implementation the open PRs with merge conflicts or failed checks; `pending`, `success` or `none` checks do not change the state. The poller does not rebase or push.
- **Transition.** `delivery_conflict` also applies from `completed`, only by the system, for merge conflicts and failed CI. The task goes to `in_progress/queued` without raising the iteration, just like a conflict at delivery. `isTerminal("completed")` does not change: while it is in completed, nothing else moves it except these conditions of the open PR.
- **Recording.** `recordPrConflict` and `recordPrCiFailure` run in an IMMEDIATE transaction: they only act if the task is in completed and the observed PR is its open PR. They append `delivery.conflict` with the last verifier's Run and `files: []`; the reason is `pr_conflict` or `ci_failed`. For CI, `output` lists the failed checks and their URLs. Repeating the failure does not enqueue the task again, because it is no longer in completed.
- **Cycle.** The implementer receives `deliveryConflict` (the `implement-task` skill explains `pr_conflict` and `ci_failed`), integrates the base on conflicts or fixes the indicated checks, and delivers again. `createPr` returns the open PR and `recordPrOpened` of the same PR writes nothing. The push uses `--force-with-lease`, so the PR is updated.
- **Cap.** The delivery conflict count starts from zero at the last `resume` or `verdict_pass`: a PR that falls into conflict weeks later does not inherit the conflicts of its first delivery.
- **Reviewers.** `verify-task` asks to choose each reviewer separately with a table of when to launch and when to skip it (security only if the diff touches a trust boundary; UX if a flow or its states change; UI if something visible changes; code if code or tests change), and that the justification of a skipped one cite the diff. It clarifies that reporting the 4 in the handoff is not launching the 4. The subagents' descriptions say when to launch them. The evidence through hooks (ADR uw-23-verificacion) does not change.

## Consequences

- A PR in conflict or with failed CI spends one more implementation and one more verification; it is what the human used to do by hand.
- Detection depends on the poller's interval (60 s by default) and on GitHub having computed `mergeable`; an `unknown` is resolved in the next pass.
- The reviewers and skills installed in `~/.claude/` are updated with `lunasq install`.
