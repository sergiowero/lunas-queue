# Pass refused by git: back to implementation

**Status:** accepted

## Context

`submit_verdict` with a pass rejects with `dirty_worktree` or `head_changed` if the worktree has
uncommitted changes or the `HEAD` is not the commit that passed the gate. Those states are almost
always caused by the implementer or the environment (an unrelated untracked file, a commit that is
not code), not by the verifier. The verifier cannot commit, discard or move the `HEAD`, so the task
was left without an exit: the verifier reported a failure and the task did not advance.

## Decision

A pass refused by `dirty_worktree` or `head_changed` becomes a reject of the same Run:

- The stored handoff is the verifier's with `verdict: "reject"` and a single must-fix
  `source: "approver"`, `severity: "major"`, `file` = first dirty file (or `.` if it is the `HEAD`) and
  `evidence` with the reason and the list of files.
- The transition is `verdict_rework`, so the task goes back to implementation (or to
  `needs_human` if it reaches the project's iteration cap).
- The implementer receives the must-fix in `rework` of `get_task_context` and fixes it: commits what
  belongs to the change, ignores what is generated (`.gitignore`) or foreign (`.git/info/exclude`), and resends
  `submit_for_verification`.

Other rejections of the pass (`test_gate_failed`, `reviewer_evidence_mismatch`, `hook_blocked`) do not
change.

## Consequences

- The verifier no longer sees `dirty_worktree` or `head_changed` on a pass; it must restore what the
  reversal test touched before issuing it.
- A pass without a prior green gate also goes back to implementation, where the agent runs
  `submit_for_verification` and generates the gate.
- It counts as a verification iteration, so the project's cap still bounds the loop.

See also the ADRs uw-11-gate-tests, uw-15-mcp-tools and uw-24-archivo-evidencia.
