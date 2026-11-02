# UW-23 — Verification phase: reviewer evidence, cap, risk, rework and phase hooks

- Status: accepted
- Date: 2026-10-29
- Unit: UW-23 · Code: `packages/domain/src/verdict.ts`, `phaseProfile` and `maxVerificationIterations` in `packages/domain/src/project-config.ts`, `recordVerdict` and `latestHandoff` in `packages/db/src/runs.ts`, `VerdictRecordedPayload` and `TaskContext.rework` in `packages/schemas/src/mcp.ts`, `PhaseHooks` in `packages/server/src/mcp/ports.ts`, `submitForVerification` and `submitVerdict` in `packages/server/src/mcp/service.ts`

## Context

`docs/design.md` (§Verification with subagents and §Implementation ↔ verification loop) defines the phase: an approver on Sonnet that launches 4 reviewers and issues pass or reject. The verdict is rejected if it reports a reviewer that does not appear in the hooks. A reject goes back to implementation with only the must-fix, the loop has a cap of 3 configurable iterations and the risk label reaches the PR.

The earlier units left almost all the pieces:

- UW-03: the verdict schema.
- UW-04: `verdict_rework` with its cap.
- UW-11: the gate before the pass.
- UW-15: `submit_verdict`.
- UW-19: `run_subagents`.

ADR uw-10-hooks leaves the `after_implementation`, `before_verification` and `after_verification` points to UW-23. ADR uw-11-gate-tests warns that a hook that commits before verifying invalidates the pass if the gate does not run again. UW-23's criterion: a pass case and a reject case go through the loop, and the fourth iteration ends in Needs human.

## Decision

- **Reviewer evidence** (`checkReviewerEvidence`, domain). Compares the verdict with `RunSubagentRepository.forRun(runId)` by `agentType`. Only the approver's Run records count. Rules:
  - A `ran` reviewer needs at least one execution with `SubagentStop`. With no records, the error says "does not appear in the hooks"; with `SubagentStart` without `SubagentStop`, "did not finish". If it was relaunched, one finished execution is enough.
  - A `skipped` reviewer cannot have a finished execution, because the approver would be discarding a report. One that started and did not finish (crashed) can be skipped with a justification.
  - A must-fix or a refuted finding cannot have a skipped reviewer as its `source`.
  - Subagents that are not reviewers (e.g. `Explore`) are ignored.
  - The error is `reviewer_evidence_mismatch` with issues by path, without effects: the Run stays open to correct.
  - The check runs before the pass's gate. If the Run already recorded a verdict, it is not repeated: the transaction decides (idempotent or `verdict_already_recorded`).
- **Approver on Sonnet.** `phaseProfile(config, "verify")` returns `model: "sonnet"` (`DEFAULT_VERIFY_MODEL`) if the profile does not set a model. The value is resolved on read, like the phase timeout (ADR 0008): it reaches `--model` and `runs.model` without migrating projects. An explicit model in the profile prevails.
- **Configurable cap.** `limits.maxVerificationIterations` (integer from 1 to 20, optional; default `DEFAULT_MAX_ITERATIONS`, 3) reaches `verdict_rework` as `maxIterations`. ADR 0007's semantics do not change:
  - With the default, three reworks fit. The iteration is 0‑based: the first verification has iteration 0, and that is how `verification.verdict_recorded.iteration` and `rework.iteration` report it.
  - The rejects of verifications 1 to 3 go back to implementation.
  - The fourth's reject takes the task to `needs_human` with `iterations_exhausted`.
- **Risk and event.** In the transaction that stores the verdict (pass or reject), `recordVerdict`:
  - sets `tasks.risk_label`;
  - appends `verification.verdict_recorded` (actor `agent`, published in the outbox) with Run, verdict, the Run's iteration, risk, count of must-fix and refuted findings, and skipped reviewers.

  The full handoff, with the refuted findings and their reasons, stays in the Run. With a pass, that event is delivery's trigger (UW-26), because `verdict_pass` is not emitted until the PR is created (ADR uw-15-mcp-tools). On a reject, the label stays as the approver's latest assessment; the next verdict replaces it.
- **Rework with only the must-fix.** `TaskContext.rework` (`{runId, iteration, mustFix} | null`) arrives in implementation when the task's last stored verdict is a reject. `verificationHistory` is empty in implementation and complete in verification: the implementer does not see per‑reviewer reports or refuted findings. If the last verdict is a pass (e.g. when coming back because of a delivery conflict), `rework` is null.
- **Phase hooks** through the `PhaseHooks` port, which `HookService` implements. `createApp` receives `phaseHooks`; without it, it uses `NoPhaseHooks`, which passes without running anything, like a project without `lunasq/hooks/`.
  - **`after_implementation` and `before_verification` run inside `submit_for_verification`**, in that order, after checking clean worktree and commits, and before the gate. This way the gate tests the HEAD that includes what the hooks committed, the `headSha` that the pass compares already includes it and the verifier is dispatched when they have finished. The design said "after the gate"; it was changed so as not to run the suite twice. Both carry the implementer's Run; `before_verification` has `LUNASQ_PHASE=verify`, which `hookPointPhase` sets.
  - **`after_verification` runs inside `submit_verdict`**, after the pass's gate and before the transaction, with `LUNASQ_PHASE_RESULT` equal to the verdict. Running it after the reject was discarded: the task would already be in `in_progress/queued` and the scheduler could dispatch the implementer while the hook writes in the worktree.
  - A `blocked` point answers `hook_blocked` with the script and the error. Nothing else is recorded: HookService already escalated the task to `needs_human` with `hook_failed`. The Run stays open, as in the other escalations (UW-17), and on resuming a new Run of the same phase starts.
  - Before the hooks and the gate, both tools check that the task is still in `in_progress/running` or `verification/running`. If not, they answer `transition_rejected` without effects. This way, retrying after `hook_blocked` (the task already in `needs_human`) does not run hooks or the suite again in the worktree while the human is handling it.
  - The hooks run with the Run's `gate_in_progress` lock, so a concurrent retry does not launch them twice. A retry after a rejection does run them again, which is why they must be idempotent (ADR uw-10-hooks).

## Consequences

- `submit_for_verification` and `submit_verdict` can take as long as the hooks plus the gate take. The `MCP_TOOL_TIMEOUT` that UW-16 sets must cover both. If a project has long hooks, it is better to move them to `before_delivery` or raise that timeout.
- A commit from `after_verification` with a pass enters the branch after the `verdict_pass` gate. The final delivery gate (UW-26), which runs after the rebase, covers it.
- **UW-26** subscribes to `verification.verdict_recorded` with `verdict: pass` to start delivery and reads the risk label from `tasks.risk_label` or from the handoff.
- **UW-18**: the `verify-task` skill must report as `ran` every reviewer it launched and that finished, also one whose report it discarded. `reviewer_evidence_mismatch` is corrected in the same Run. The `implement-task` skill reads `rework.mustFix`.
- **UW-29** composes `HookService` as `phaseHooks` in `createApp`.
- `before_implementation` (on dispatch) and `on_failure` remain pending; ADR uw-16-dispatcher leaves them open.
