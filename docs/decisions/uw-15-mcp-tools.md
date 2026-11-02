# UW-15 — LunasQ MCP tools, run token and phase closing

- Status: accepted
- Date: 2026-10-29
- Unit: UW-15 · Code: `packages/server/src/mcp/`, `packages/schemas/src/mcp.ts`, `packages/db/src/runs.ts`, `packages/db/drizzle/0003_runs_context_read.sql`

## Context

`docs/design.md` (§MCPs and skills) lists the 7 tools and asks that they validate the run token, that `get_task_context` be mandatory before any exit tool and that an invalid handoff be rejected with its errors. ADR 0001 fixes the stateless v2 SDK on Hono and ADR 0002 the `X-LunasQ-Run-Token` header. ADR 0007 leaves each guard's facts to the caller and ADR 0013 leaves `submit_spec`'s entry to UW-15. What remained to decide was who closes the Run, how the context read is recorded, where the checklist lives and what the test gate does while UW-11 is pending.

## Decision

- **Endpoint.** `/mcp` in `createApp`, with `createMcpHonoApp()`: validates Host and Origin for localhost. Each request creates its `McpServer` and its stateless transport. The run token is read from the header on every request.
- **Invalid token.** Without a header, with an unknown token or with the token of a closed Run, the handshake and `tools/list` work, but every `tools/call` answers `isError` with `invalid_run_token` and has no effects. 401 is not answered because MCP clients interpret it as a request for OAuth.
- **Guards.** Every tool goes through these guards, in order:
  1. Active Run (`ended_at IS NULL`).
  2. Tool allowed in the Run's phase (`tool_not_allowed`): `submit_spec` in refine; `submit_result` in refine and implement; `update_checklist` and `submit_for_verification` in implement; `submit_verdict` in verify. `get_task_context`, `ask_human` and `report_failure` are accepted in all.
  3. `get_task_context` already read (`context_required`).
  4. In verify, if the Run already recorded a pass verdict, only `get_task_context` and `submit_verdict` are accepted. This way the token, which stays alive for delivery, can no longer take the task to `waiting_human` or close the Run as failed.
- **Context read.** The column `runs.context_read_at` (migration `0003`) stores the first call to `get_task_context`; repeating it does not move the mark. Being a column and not an event, the guard is a lookup by the Run's key.
- **Errors.** The response is `isError` with a JSON body `{error, message, issues?, output?}`. `issues` uses `parseHandoff`'s `{path, message}` format (ADR 0006).
- **Handoff.** The `inputSchema` accepts `{handoff: object}` and the validation is done by `parseHandoff`: this way the errors come out in English and the cross‑field rules apply. Then it is checked that `phase`, `taskId` and `runId` are the Run's (`handoff_mismatch`). Finally, the criteria are compared against the approved spec (`spec_mismatch`): `criterionTests` and `criteriaVerdicts` must name exactly its criteria. A rejection leaves the Run open to fix and retry.
- **Who closes the Run.** The exit tool, in the same `IMMEDIATE` transaction that stores the handoff and applies the transition. This way the token goes stale immediately, and a rejection by the state machine rolls everything back, including the spec version (`SpecRepository.applySubmit`).
  - `submit_spec`, `submit_for_verification` and `submit_verdict` with reject close with `success`.
  - `report_failure` closes with `failure` and its `failure_reason`.
  - `submit_verdict` with pass stores the handoff with the Run open, because `verdict_pass` is emitted by delivery (ADR 0007). Repeating the same verdict is idempotent; a different one answers `verdict_already_recorded`.
  - The dispatcher (UW-16) only stops and cleans up the pane.
- **`submit_result`.** Alternative exit of refine and implement for tasks without code (ADR 0007): own handoff (`parseResultHandoff`), `handoff_mismatch` if ids or phase are not the Run's, and from implement `branch_has_commits` if the branch has commits on top of the base (`CommitVerifier.branchHasCommits`). It writes the Result, the title if missing, the transition to completed and the closing of the Run with `success` in one transaction, without a test gate or phase hooks.
- **`submit_for_verification`.** Criteria coverage → clean worktree → commits → test gate → transaction. Detail:
  - With uncommitted changes (`git status --porcelain`, including untracked files) it answers `dirty_worktree`, because the gate must run on what goes in the commits.
  - `CommitVerifier` (port) checks that each SHA is in the worktree's `HEAD` and not in the base branch, neither the local one nor `origin/<base>` when it exists (the worktree comes from `origin/<base>` and the local one may be behind; [ADR uw-18-skills-fase](uw-18-skills-fase.md)). `GitCommitVerifier` does it with `git merge-base` through the `ProcessRunner`.
  - `TestGate` (port) runs the project's test command in the worktree. `ShellTestGate` is the minimal implementation until UW-11: without a test command, the gate does not pass.
  - The git commands pass the arguments after `--end-of-options`, so a base branch shaped like an option is not interpreted as an option.
  - `ShellTestGate` cuts at 20 minutes by default (`DEFAULT_GATE_TIMEOUT_MS`, configurable).
  - While a Run's gate runs, another `submit_for_verification` of the same Run answers `gate_in_progress` and does not launch a second suite. The lock lives in memory, because there is only one process. The gate is not canceled if the client abandons the call: `ProcessRunner` receives no abort signal.
  - The gate runs outside the transaction. If in the meantime the dispatcher closed the Run, the closing fails with `invalid_run_token`. If the task changed, the transition, which carries `expected: in_progress/running`, is rejected without closing the Run.
  - A red gate answers `test_gate_failed` with the tail of the output (4000 characters).
- **`ask_human`.** In one transaction it applies `ask_human` (running → waiting_human) and creates the Question with the `question.created` event. If the task is already waiting for the human, it is rejected without creating another. Pausing the timeout and delivering the answer belongs to UW-22.
- **Checklist.** No new table: `update_checklist` appends the `checklist.updated` event with the full snapshot of the approved task list, and the last event is the current checklist. Repeating the same mark adds no event. Ids that are not in the spec are rejected.
- **`report_failure`.** Applies `run_failed` with actor `system`, the only one allowed by ADR 0007: the agent declares the failure and the system records it. `attempt` is the phase's consecutive failed Runs, since the task's last `resume`, plus one (`consecutiveFailures`).
- **`get_task_context`.** Returns `TaskContext` (`@lunasq/schemas`):
  - task, Run and project (base branch and test command);
  - approved spec; in refinement, also the latest version with changes requested and its comments;
  - last implementation handoff and earlier verdicts;
  - the previous closed Run of the same phase, with its failure reason and its handoff;
  - Questions and last checklist.

## Consequences

- The gate inherits the LunasQ process's environment, including `gh`'s tokens. UW-11 must pass it a minimal environment when running it in the pane.
- The project's conventions do not travel in `get_task_context`: the agent reads them from the repo (CLAUDE.md, AGENTS.md) and from its skill. The context only carries the base branch and the test command.
- If the response of a successful exit tool is lost, the retry answers `invalid_run_token`, because the Run has already closed: it does not duplicate effects, but it does not return the original result. UW-18 must state in the skills that this error after an exit tool means the phase has already ended.

- UW-16 creates the Run with its token and does not close Runs that an exit tool already closed. On seeing the task outside `running`, it cleans up the pane.
- UW-11 replaces `ShellTestGate` with execution in a herdr pane and stores the output. The `TestGate` port does not change, except for the `trigger` field; it also runs the gate before accepting a pass ([ADR uw-11-gate-tests](uw-11-gate-tests.md)).
- The gate is synchronous inside the MCP call: a suite longer than Claude Code's tools timeout (`MCP_TOOL_TIMEOUT`) cuts the call. UW-16 must set that timeout in the phase's profile or UW-11 must bound the suite.
- UW-23 adds to `submit_verdict` the validation of the reviewers against the hooks; UW-26 runs the final gate and emits `verdict_pass`.
- UW-18 documents the error codes in the skills and that a rejection is fixed in the same Run.
