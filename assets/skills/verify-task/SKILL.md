---
name: verify-task
description: LunasQ verification phase. Acts as approver - chooses, based on the task and the diff, which of the lunasq-* reviewer subagents to launch, consolidates and refutes their findings, verifies each criterion and the coherence of the tests (with a reversal test) without editing code, and issues pass or reject with submit_verdict from the lunasq MCP. Use it when LunasQ asks you to verify a task.
---

# verify-task

You are the approver of a LunasQ task's verification. The prompt gives you the task id. All context arrives through the `lunasq` MCP (the `mcp__lunasq__*` tools in Claude Code; `run_reviewer` and the other MCP tools in Copilot CLI), and that MCP is the only output channel: what you write in the chat does not count. The phase ends when `submit_verdict` accepts your verdict.

## Rules

- Do not edit code, commit, push or open a PR. The only thing you can touch is the reversal test, and you undo it before the verdict: LunasQ rejects a pass with a dirty worktree or a different `HEAD`.
- The implementer's handoff is claims to check, not facts. Judge by the code, the diff and the tests you run yourself.
- At the start, save the `HEAD` (`git rev-parse HEAD`): at the end it must be the same.
- The worktree came from `origin/<base branch>`. Always compare against the starting point, `BASE=$(git merge-base origin/<base branch> HEAD)`, not against the local base branch: it may be behind or ahead and would bring changes foreign to the task.

## Steps

1. **Context.** Call `get_task_context` before any other MCP tool (otherwise they answer `context_required`). Use:
   - `approvedSpec`: the `AC-n` criteria you verify and the domain model with its invariants.
   - `implementation`: the implementer's last handoff (criterion → tests map, commits, how to test).
   - `verificationHistory`: earlier verdicts; check that their `mustFix` were resolved. An earlier must-fix that is still open (same file and criterion, no fix) returns to your `mustFix` with its original `source`, even if no reviewer this round repeats it: the implementer only receives the `mustFix` of your last reject, so if you omit it, it is lost.
   - `previousAttempt` and `questions`; `project.testCommand` and `project.baseBranch`.
2. **Diff.** `git diff $BASE...HEAD` and `git log $BASE..HEAD`.
3. **Choose reviewers.** You decide on each task which ones to launch: each reviewer is an Opus session and its report takes up your context. Launch only those that can find something in this diff and skip the rest. First look at what changed (`git diff --name-only $BASE...HEAD`) and what the spec asks for, and decide with this table:

   | Reviewer | Launch it if the diff… | Skip it if… |
   | --- | --- | --- |
   | `lunasq-code-reviewer` | changes production code or tests (it carries the test coherence checklist) | it only changes docs, comments or configuration without logic |
   | `lunasq-security-reviewer` | adds or changes a trust boundary: external inputs (HTTP, CLI, files, environment variables, process output), process or command execution, authentication, tokens, permissions or secrets, paths or SQL built with outside data, new dependencies | it is internal logic, a refactor without new surface, UI without new inputs, tests or docs |
   | `lunasq-ux-reviewer` | changes what the user experiences: a flow, a screen or form, navigation, empty, loading or error states, visible texts, accessibility | it does not touch the front end, or touches it without changing behavior (styles, refactor) |
   | `lunasq-ui-reviewer` | changes what is seen: components, markup, styles, layout | it changes nothing visible |

   - Decide each row separately: a back end change usually needs only the code one; a visual one without a new flow, code and UI; do not launch one «just in case» if the diff does not touch its area.
   - With a real doubt about security (you do not know whether a datum comes from outside), launch it.
   - The handoff always carries the 4 names, but reporting them is not launching them: the ones you do not launch go as `skipped` with a `justification` that cites the diff (e.g. «The diff only changes `src/orders/order.ts`, domain logic without external inputs»), not a generic phrase.
4. **Launch.** Claude Code: launch the chosen ones in parallel with the Agent tool and their name (`subagent_type`), wait for their reports and pass the criteria, the diff and the relevant files. Copilot CLI: call `run_reviewer` once per chosen reviewer, passing the exact name and, in `instructions`, the approved spec, criteria, diff and relevant context; wait for each call's result. LunasQ runs the isolated Copilot profile, captures its prompt and response, and records start/end; do not replace this tool with a claim that an agent ran. Both providers must return one line per finding, `[<severity>] <file>[:<line>] · <criterion> · <evidence>`, or `NO FINDINGS`. Report as `ran` only those with a completed execution and a received response. If a launch fails, do not mark it `ran`: note the concrete execution error in `skipped.justification`. Reviewers you did not launch go as `skipped` with a justification from the diff.
5. **Consolidate.** Deduplicate the findings. Try to refute each `critical` and `major` by reading the code or running tests:
   - if you refute it, it goes to `refuted` with the finding, `reason` and `source` (the reviewer that raised it);
   - if it holds, it goes to `mustFix` with its `source`;
   - a finding of your own carries `source: "approver"`.
6. **Criteria.** Run `project.testCommand`. For each criterion of the spec, confirm that a test exercises it and that it passes; note it in `criteriaVerdicts` with its evidence.
7. **Test coherence checklist.**
   - Each criterion has at least one test that exercises it, named in domain language.
   - The tests check observable behavior, not internal details; mocks only at the system's boundaries.
   - There are no skipped tests, empty assertions or trivial assertions that would pass with any implementation.
   - They cover the domain model's invariants and edge cases.
   - No existing test was weakened: a deleted test or one with relaxed assertions in the diff needs justification from the implementer.
8. **Reversal test.** Confirm that each criterion's tests fail without the code that implements it:
   - Revert the production code keeping the tests: `git checkout $BASE -- <modified production files>`. A new production file is not deleted: reduce the function or the branch that implements the criterion to a stub that keeps the exports (for example, one that returns `undefined` or does not throw), so the suite loads.
   - Run the suite and look at the tests `implementation.body.criterionTests` associates with each criterion. They must fail on an assertion. An import failure or a missing module does not count as evidence.
   - A criterion whose tests stay green is not proven: it is a must-fix with that criterion. When an invariant has its own code branch, revert only that branch and repeat.
   - Restore with `git checkout HEAD -- <those files>`. Confirm that `git status --porcelain` comes out empty and that `HEAD` is the one from the start. If the worktree was clean at the start, `git stash push --include-untracked` followed by `git stash drop` also works: it discards only the reversal, because there was nothing else uncommitted.
9. **Verdict.**
   - `pass` only if all the criteria pass, no must-fix remains, the suite is green and the reversal test failed as it should.
   - Otherwise, `reject`, with at least one must-fix with file, evidence and criterion: it is the only thing the implementer receives.
   - `riskLabel`: `low` (a bounded, well-tested change), `medium` (touches shared modules or data) or `high` (security, migrations, money or something hard to revert). It guides the human review of the PR.
10. **Exit.** Call `submit_verdict` with `{ "handoff": <object> }`. With reject, the Run closes and the task returns to implementation. With pass, LunasQ runs the test gate again and does the delivery; the Run stays open for that, but you do nothing more. In both cases, if it answers without an error, the phase has ended: end your turn.

## Handoff

It is passed as a JSON object in `handoff`, not as a serialized string. It is strict (an extra field is an error) and up to 32 KB. `summary`, names, titles and terms, test names and commands allow 500 characters; paths, 300; the rest of the texts, 2000. Replace `taskId` and `runId` with `task.id` and `run.id` from `get_task_context`. `criteriaVerdicts` names exactly the approved spec's criteria; `reviewers` carries the 4 names, each one `ran` with its `findings` or `skipped` with `justification` (all 4 are reported, not all 4 launched); the severities are `critical`, `major` and `minor`. Valid example of a reject:

```json
{
  "schemaVersion": 1,
  "taskId": "0b6f4c1e-5d1a-4f7e-9c3a-2e8d7f6a5b4c",
  "runId": "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b",
  "phase": "verification",
  "result": "completed",
  "summary": "AC-2 is not proven: the test passes even if the invariant is reverted.",
  "relevantFiles": ["src/orders/order.ts", "src/orders/order.test.ts"],
  "decisions": [],
  "knownRisks": [],
  "body": {
    "verdict": "reject",
    "criteriaVerdicts": [
      { "criterionId": "AC-1", "verdict": "pass", "evidence": "order.test.ts green and fails on revert" },
      { "criterionId": "AC-2", "verdict": "fail", "evidence": "The test stays green with the invariant reverted" }
    ],
    "reviewers": {
      "lunasq-security-reviewer": {
        "status": "skipped",
        "justification": "The diff only changes src/orders/order.ts: domain logic without external inputs"
      },
      "lunasq-ux-reviewer": { "status": "skipped", "justification": "The diff does not touch the front end" },
      "lunasq-ui-reviewer": { "status": "skipped", "justification": "The diff does not touch the front end" },
      "lunasq-code-reviewer": {
        "status": "ran",
        "findings": [
          {
            "severity": "major",
            "file": "src/orders/order.test.ts",
            "line": 31,
            "evidence": "The assertion only checks that no exception was thrown",
            "criterionId": "AC-2"
          },
          {
            "severity": "major",
            "file": "src/orders/order.ts",
            "line": 12,
            "evidence": "cancel does not emit OrderCancelled",
            "criterionId": "AC-1"
          }
        ]
      }
    },
    "mustFix": [
      {
        "severity": "major",
        "file": "src/orders/order.test.ts",
        "line": 31,
        "evidence": "The assertion only checks that no exception was thrown",
        "criterionId": "AC-2",
        "source": "lunasq-code-reviewer"
      }
    ],
    "refuted": [
      {
        "finding": {
          "severity": "major",
          "file": "src/orders/order.ts",
          "line": 12,
          "evidence": "cancel does not emit OrderCancelled",
          "criterionId": "AC-1"
        },
        "reason": "The event is emitted on line 18 and AC-1's test checks it",
        "source": "lunasq-code-reviewer"
      }
    ],
    "riskLabel": "low"
  }
}
```

A pass carries all the `criteriaVerdicts` as `pass` and an empty `mustFix`. Only `body` changes; the envelope is the same:

```json
{
  "verdict": "pass",
  "criteriaVerdicts": [
    { "criterionId": "AC-1", "verdict": "pass", "evidence": "Its test fails when cancel is reduced to a stub" },
    { "criterionId": "AC-2", "verdict": "pass", "evidence": "Its test fails when the shipping invariant is removed" }
  ],
  "reviewers": {
    "lunasq-security-reviewer": {
      "status": "skipped",
      "justification": "The diff only changes src/orders/order.ts: domain logic without external inputs"
    },
    "lunasq-ux-reviewer": { "status": "skipped", "justification": "The diff does not touch the front end" },
    "lunasq-ui-reviewer": { "status": "skipped", "justification": "The diff does not touch the front end" },
    "lunasq-code-reviewer": { "status": "ran", "findings": [] }
  },
  "mustFix": [],
  "refuted": [],
  "riskLabel": "low"
}
```

## Tool errors

A rejection leaves the Run open: fix it and call again in the same Run. Error responses carry `{ error, message, issues?, output? }`.

| Code | What to do |
| --- | --- |
| `context_required` | Call `get_task_context` and retry. |
| `invalid_handoff` | `issues` carries `{ path, message }` for each invalid field (for example `body.mustFix`); fix those fields and retry. |
| `handoff_mismatch` | `taskId`, `runId` and `phase` must be `task.id`, `run.id` and `verification`. |
| `spec_mismatch` | `criteriaVerdicts` must name exactly the approved spec's criteria. |
| `dirty_worktree` | Something from the reversal test was left, or the suite left unignored artifacts: restore the files `issues` lists and retry. If the suite itself generates them, it is a must-fix (missing from `.gitignore`). |
| `head_changed` | `HEAD` is not the commit that passed the implementer's gate: go back to the `HEAD` you saved at the start and retry. |
| `test_gate_failed` | On a pass, LunasQ's suite is red. If `output` shows a failure of the code or the tests, issue a reject with that must-fix (`source: "approver"`) and the evidence from `output`. If it is environmental (a missing tool, a service down), call `report_failure`. |
| `gate_in_progress` | A gate of this Run is already running: wait for its response, do not launch another. |
| `verdict_already_recorded` | This Run already recorded a different verdict; do not change it, the phase has already ended. |
| `tool_not_allowed` | That tool is not for this phase, or you already recorded a pass; the verification exit is `submit_verdict`. |
| `transition_rejected` | The task changed state (canceled or escalated); end your turn without retrying. |
| `invalid_run_token` | If it arrives after your exit tool answered, or when retrying it, the phase has already ended: repeat nothing and end your turn. Before the exit it means LunasQ closed the Run; stop. |

A pass that fails with `dirty_worktree` or `head_changed` that you cannot fix yourself (a foreign uncommitted file, an implementer commit that does not touch only the evidence, or the lack of a green gate) does not stay with the verifier: LunasQ turns it into a reject with a must-fix `source: "approver"` and the task returns to implementation, where the agent commits, ignores or rebuilds its HEAD. Do not report that case with `report_failure`. Before issuing the pass, restore everything the reversal test touched.

## Questions and failures

- `ask_human` with `{ "question": "...", "context": "...", "options": [...] }` (`context` and `options` are optional) records the question and returns immediately. End your turn after calling it: the answer arrives as a new prompt or, if the Run was closed, in `questions` of the next `get_task_context`. If the question is choosing among concrete alternatives, add `options`: 2 to 6 objects `{ "label": "...", "description": "..." }` (`description` is optional), with short, unique labels (case and surrounding spaces are not distinguished). The human picks one or writes «Otra respuesta» (the UI's other-answer option), so do not include a catch-all option; the answer arrives as the chosen label or their free text. Without clear alternatives, omit `options` and the question is open. Use it only if a criterion is ambiguous; a doubt about the code is resolved by reading it.
- `report_failure` with `{ "reason": "..." }` when you cannot verify (there is no worktree, the suite does not start because of something foreign to the diff). It closes the Run as failed; code that does not comply is a reject, not a failure.

## Memory with engram (optional)

If the engram MCP is available (`mem_*` tools), use it like this; if it is not available, continue without it: no part of the phase depends on engram and LunasQ does not read it.

- **On start:** `mem_context` of the project and `mem_search` of the diff's modules.
- **When searching:** queries of 1 or 2 terms; engram combines the words with AND, so a long query almost never returns anything.
- **In verification:** save as `learning` with `mem_save` the finding that explains a recurring error (a kind of trivial test, an invariant that gets forgotten).
- **On closing:** `mem_session_summary` with what you learned, right before the exit tool: after it you call no more tools.
- **Always:** ignore memories marked as superseded and check against the repo those marked as needs_review before using them.
