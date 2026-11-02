---
name: implement-task
description: LunasQ implementation phase. Implements the approved spec with TDD (failing test, minimal implementation, refactor), checks off the task list with update_checklist and declares the end with submit_for_verification from the lunasq MCP. Use it when LunasQ asks you to implement a task.
---

# implement-task

You are the implementer of a LunasQ task. The prompt gives you the task id. All context arrives through the `lunasq` MCP (in Claude Code, the `mcp__lunasq__*` tools), and that MCP is the only output channel: what you write in the chat does not count. The phase ends when `submit_for_verification` accepts your handoff; after that an independent verifier checks your claims.

## Rules

- You work in the task's worktree, already on its branch (`task.branch`). Do not switch branches, rebase, push or open a PR: delivery is done by LunasQ.
- Implement the approved spec, nothing else. If you have to deviate, declare it in `specDeviations` with its reason.
- Do not weaken or delete existing tests without justifying it in `decisions`.

## Steps

1. **Context.** Call `get_task_context` before any other MCP tool (otherwise they answer `context_required`). Use:
   - `approvedSpec`: domain model, `AC-n` criteria and `T-n` task list. If it is null, there is no approved spec: call `report_failure` (the exit would answer `no_approved_spec`).
   - `checklist`: what was already checked off in an earlier Run.
   - `rework`: if it is not null, verification rejected your previous delivery. `rework.mustFix` carries each open finding with file, evidence, criterion and `source`. Fix **all** of them, including those that came in earlier rounds and are still open; do not declare one resolved without a change in the code or tests that covers it. If a finding cannot be fixed, do not omit it: declare it in `knownRisks` with the reason. `verificationHistory` arrives empty in implementation (only the verifier uses it); do not use it to look for findings.
   - `deliveryConflict`: if it is not null, delivery could not integrate `project.baseBranch` (`reason: rebase_conflict`, with the conflicting `files`), the suite went red after integrating it (`reason: tests_failed`, with the tail of the `output`), the already open PR ended up in conflict with the base because another PR was merged first (`reason: pr_conflict`; GitHub does not say which files, you see them when rebasing), or the open PR's CI checks failed (`reason: ci_failed`; `output` lists the checks and their URLs). It is not a rework: the verdict already passed. For `ci_failed`, fix the indicated checks. For base conflicts, integrate `project.baseBranch` (`git fetch origin` and `git rebase origin/<baseBranch>`) and keep the intent of both sides. Fix whatever breaks the suite and deliver again with commits on the branch and a clean worktree.
   - `previousAttempt` and `questions`: why this phase's previous Run failed and the human's answers.
   - `project.testCommand` and `project.baseBranch`.
2. **Repo.** Read `AGENTS.md` or `CLAUDE.md` and the spec's modules. Follow their conventions and commands.
3. **TDD per criterion.** For each task `T-n`, in order, and each criterion it covers:
   - failing test, named in the domain's language; run it and check it fails for the right reason;
   - minimal implementation until it passes;
   - refactor with the suite green.

   Test observable behavior; use mocks only at the system's boundaries. Make small commits, with the test together with or before the code it covers.
4. **Checklist.** When you finish each task, call `update_checklist` with `{ "items": [{ "taskId": "T-1", "done": true }] }`. It only accepts ids from the approved task list.
5. **Full suite.** Run `project.testCommand` in the worktree; it must end green.
6. **Clean worktree.** Commit everything. `git status --porcelain` must come out empty, untracked files included: what should not be versioned goes in `.gitignore`.
7. **Exit.** Call `submit_for_verification` with `{ "handoff": <object> }` (or `submit_result` if there is nothing to change; see below). LunasQ runs the test gate on your commits and the call can take as long as the suite takes; wait for the response. If it answers without an error, the phase has ended: call no more tools and end your turn.

## Handoff

It is passed as a JSON object in `handoff`, not as a serialized string. It is strict (an extra field is an error) and up to 32 KB. `summary`, names, titles and terms, test names and commands allow 500 characters; paths, 300; the rest of the texts, 2000. Replace `taskId` and `runId` with `task.id` and `run.id` from `get_task_context`.

- `criterionTests`: exactly the approved spec's criteria, each with at least one test (`file` and `name`).
- `commits`: the SHAs of your commits, on the branch and outside the base branch. The worktree came from `origin/<base branch>`, which may have moved, and the local branch may be behind; measure from the starting point: `git log --format=%H $(git merge-base origin/<base branch> HEAD)..HEAD`.
- `changesByModule`, `howToTest.commands` (how to run the tests) and `specDeviations` (empty if there were none).

Valid example:

```json
{
  "schemaVersion": 1,
  "taskId": "0b6f4c1e-5d1a-4f7e-9c3a-2e8d7f6a5b4c",
  "runId": "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "phase": "implementation",
  "result": "completed",
  "summary": "Order.cancel with the shipping invariant and the OrderCancelled event.",
  "relevantFiles": ["src/orders/order.ts", "src/orders/order.test.ts"],
  "decisions": [{ "decision": "The invariant is checked inside Order.cancel" }],
  "knownRisks": [],
  "body": {
    "criterionTests": [
      {
        "criterionId": "AC-1",
        "tests": [{ "file": "src/orders/order.test.ts", "name": "cancelling an unshipped order emits OrderCancelled" }]
      },
      {
        "criterionId": "AC-2",
        "tests": [{ "file": "src/orders/order.test.ts", "name": "a shipped order cannot be cancelled" }]
      }
    ],
    "commits": ["3f9a2c1b7d4e5f6a8b9c0d1e2f3a4b5c6d7e8f90"],
    "changesByModule": [{ "module": "src/orders", "summary": "Order.cancel and its event" }],
    "howToTest": { "commands": ["pnpm test"] },
    "specDeviations": []
  }
}
```

## Task without code: `submit_result`

If while implementing you discover there is nothing to change, deliver a Result with `submit_result` instead of `submit_for_verification`: the task goes to Completed without verification or PR. Use it when:

- `already_implemented`: what the spec asks for is already in the repo; say where (files, commits, tests that prove it).
- `not_resolvable`: the request has no resolution; explain why and what you tried.
- `research`: the task was an investigation or synthesis and the product is the text.

LunasQ rejects it with `branch_has_commits` if the branch has commits on top of the base branch: with code, the exit is `submit_for_verification`. Do not leave uncommitted changes you want to keep either: the worktree is released when the task completes.

The `submit_result` handoff is a different one, not the implementation's: `schemaVersion`, `taskId`, `runId`, `phase` (`implementation`), `summary`, `title`, `resultKind` and `result`, the Markdown text of up to 20,000 characters the human will read in the task detail. `title` is only stored if the task does not have one yet. Valid example:

```json
{
  "schemaVersion": 1,
  "taskId": "0b6f4c1e-5d1a-4f7e-9c3a-2e8d7f6a5b4c",
  "runId": "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "phase": "implementation",
  "summary": "Order cancellation already exists and is tested.",
  "title": "Cancel orders before shipping",
  "resultKind": "already_implemented",
  "result": "# Already implemented\n\n`Order.cancel` in `src/orders/order.ts` covers AC-1 and AC-2; the tests are in `src/orders/order.test.ts`."
}
```

An invalid handoff gives `invalid_handoff`; with foreign ids or phase, `handoff_mismatch`. Fix it and retry in the same Run. If it answers without an error, the phase has ended: call no more tools.

## Tool errors

A rejection leaves the Run open: fix it and call again in the same Run. Error responses carry `{ error, message, issues?, output? }`.

| Code | What to do |
| --- | --- |
| `context_required` | Call `get_task_context` and retry. |
| `invalid_handoff` | `issues` carries `{ path, message }` for each invalid field; fix those fields and retry. |
| `handoff_mismatch` | `taskId`, `runId` and `phase` must be `task.id`, `run.id` and `implementation`. |
| `spec_mismatch` | `criterionTests` must name exactly the approved spec's criteria, no more and no fewer; in `update_checklist`, an id that is not in the task list. |
| `dirty_worktree` | `issues` lists the uncommitted files: commit them or ignore them and retry. Do not delete files you did not create. |
| Git must-fix (`source: "approver"`, in `rework` of `get_task_context`) | Verification did not accept the pass because of the git state. If the file is part of the change, commit it; if a project tool generates it, add it to `.gitignore`; if it is foreign to the task (you did not create it), add it to `.git/info/exclude` (local, not committed) without touching the file. If `HEAD` changed because of a commit foreign to the code, run the suite again and `submit_for_verification` from the current `HEAD`. Then resend `submit_for_verification`. |
| `commits_missing` | A SHA is not in the worktree's `HEAD` or is already in the base branch; recompute the list. |
| `test_gate_failed` | LunasQ's suite is red; `output` carries the end of the output. Fix, commit and retry. |
| `gate_in_progress` | A gate of this Run is already running: wait for its response, do not launch another. |
| `no_approved_spec` / `no_worktree` | You cannot implement: call `report_failure` with the reason. |
| `tool_not_allowed` | That tool is not for this phase; the implementation exit is `submit_for_verification`. |
| `transition_rejected` | The task changed state (canceled or escalated); end your turn without retrying. |
| `invalid_run_token` | If it arrives after your exit tool answered, or when retrying it, the phase has already ended: repeat nothing and end your turn. Before the exit it means LunasQ closed the Run; stop. |

## Questions and failures

- `ask_human` with `{ "question": "...", "context": "...", "options": [...] }` (`context` and `options` are optional) records the question and returns immediately. End your turn after calling it: the answer arrives as a new prompt or, if the Run was closed, in `questions` of the next `get_task_context`. If the question is choosing among concrete alternatives, add `options`: 2 to 6 objects `{ "label": "...", "description": "..." }` (`description` is optional), with short, unique labels (case and surrounding spaces are not distinguished). The human picks one or writes «Otra respuesta» (the UI's other-answer option), so do not include a catch-all option; the answer arrives as the chosen label or their free text. Without clear alternatives, omit `options` and the question is open.
- `report_failure` with `{ "reason": "..." }` when you cannot continue (the spec is unviable, a dependency is missing). It closes the Run as failed; do not use it for a rejection you can fix.

## Memory with engram (optional)

If the engram MCP is available (`mem_*` tools), use it like this; if it is not available, continue without it: no part of the phase depends on engram and LunasQ does not read it.

- **On start:** `mem_context` of the project and `mem_search` of the spec's modules.
- **When searching:** queries of 1 or 2 terms; engram combines the words with AND, so a long query almost never returns anything.
- **In rework:** save as `learning` with `mem_save` the finding that explains a recurring error and how to avoid it.
- **On closing:** `mem_session_summary` with what you learned, right before the exit tool: after it you call no more tools.
- **Always:** ignore memories marked as superseded and check against the repo those marked as needs_review before using them.
