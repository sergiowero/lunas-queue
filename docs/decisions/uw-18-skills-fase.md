# UW-18 — Phase skills

- Status: accepted
- Date: 2026-10-29
- Unit: UW-18 · Code: `assets/skills/{refine-task,implement-task,verify-task}/SKILL.md`, `packages/server/src/skills/`, `packages/server/src/mcp/ports.ts`, `packages/server/src/test-helpers/real-claude.ts`

## Context

`docs/design.md` (§MCPs and skills) asks for one skill per phase that describes the *how*, with the LunasQ MCP as the only exit channel, and best‑effort instructions for engram (§Brain). The dispatcher (UW-16) sends a short prompt that names the skill (`phasePrompt`: `refine-task`, `implement-task`, `verify-task`). ADR uw-15-mcp-tools leaves UW-18 to document the error codes, that a rejection is fixed in the same Run and that `invalid_run_token` after an exit tool means the phase has already ended. ADR uw-19-revisores asks `verify-task` to launch the reviewers by name and not in the background. The backlog also listed `deliver-task`, with the exit "PR url via MCP".

## Decision

- **No `deliver-task`.** The decisions after the design left delivery without an agent. `verdict_pass` is emitted only by the system after creating the PR (ADR 0007). Delivery runs inside the verifier's Run and is not scheduled (ADR 0014). The PR is created by UW-26 with `gh` (ADR uw-14-adapter-github). There is no delivery MCP tool, no delivery handoff and no `deliver` phase in `PHASE_SKILL`. A skill that nobody dispatches is not written. If in the future an agent resolves rebase conflicts, that is implementation: `delivery_conflict` sends the task back to in progress. ADR 0008's `deliver` profile goes unused for now.
- **Format.** One folder per skill with `SKILL.md`: frontmatter `name` (the folder's, the one the phase prompt cites) and `description`. `lunasq install` (UW-28) copies the folders to `~/.claude/skills/`.
- **Common content.** Each skill has these sections:
  - the phase's rules;
  - steps, starting with `get_task_context` and ending with its exit tool;
  - which `TaskContext` fields to use;
  - a valid example handoff in the first `json` block;
  - a table of error codes with what to do for each;
  - `ask_human` (records the question and the agent ends its turn) and `report_failure`;
  - the engram section with the moments from §Brain, conditioned on the MCP being available.

  The skills do not share text with each other: each one reads on its own.
- **Per phase.**
  - `refine-task` writes no code and models with DDD. The criteria are written Given / When / Then in `given / when / outcome`. A new round starts from `changesRequested`.
  - `implement-task` applies TDD per criterion and marks `update_checklist` per task. It delivers with a clean worktree and the commits `<base>..HEAD`; a rework fixes the last verdict's `mustFix`.
  - `verify-task` launches the 4 reviewers in parallel by name, not in the background, and reports the skipped ones with a justification. It refutes serious findings, applies the coherence checklist and does the reversal test, which it undoes before the verdict: a pass requires the same `HEAD` and a clean worktree. A `test_gate_failed` on a pass becomes a reject.
- **Tests.**
  - `assets/skills/skills.test.ts` checks the structure and that each skill cites what its phase needs. The package does not depend on internal packages.
  - `packages/server/src/skills/examples.test.ts` validates each skill's example with `parseHandoff`, so a schema change breaks the suite if the skill is left behind.
  - `pnpm --filter @lunasq/server test:skills` tests the criterion against real Claude Code. A toy task (a JavaScript calculator, `node --test`) goes through refinement, spec approval, implementation and verification. Each phase runs in a `claude -p` with the dispatcher's `phasePrompt`, the MCP via `--mcp-config` and `--strict-mcp-config` (without engram), the hooks settings and UW-11's gate with a local runner. It checks that each Run left a handoff that passes `parseHandoff` with the transition applied, that the refiner and the verifier left no changes, and that each reviewer reported as `ran` appears in the Run's hooks. The phases use `LUNASQ_SKILL_MODEL` (sonnet by default) and the reviewers `LUNASQ_REVIEWER_MODEL` (haiku).
- **Base branch.** The skills compare against `$(git merge-base origin/<base> HEAD)`, because the worktree comes from `origin/<base>` and the local branch may be behind (ADR 0012).
- **Task commits.** For the same reason, `GitCommitVerifier.missing` (UW-15) also rejects a SHA that is already in `origin/<base>`, in addition to those in the local base. This way, a stale local `main` does not make upstream commits pass as the task's.
- `serve` and `runClaude` move to `src/test-helpers/real-claude.ts`, shared with UW-19's `test:claude`.

## Result

With Claude Code 2.1.314, `pnpm --filter @lunasq/server test:skills` passed completely (3 of 3) with the phases on sonnet and the reviewers on haiku. Each phase left a valid handoff and applied its transition: refined, verification/queued and the verdict. The refiner did not touch the tree or the HEAD. The implementer left the checklist complete and declared the branch's commits. The reviewers reported as `ran` appear in the Run's hooks, and the verifier left the worktree clean and the same HEAD. The final run took about 5 minutes.

The review with a clean context led to these changes:
- compare against `merge-base origin/<base> HEAD` and not against the local base branch;
- a reversal test per criterion that does not count an import failure as evidence;
- `mem_session_summary` before the exit tool;
- a validated pass example;
- an `origin` in the test repo.

## Consequences

- **UW-23**: the skill already asks to report as `ran` only the reviewers launched; `test:skills` checks exactly that against the hooks, so UW-23's validation should not break the flow.
- **UW-26**: without an agent in delivery, the PR description comes from the handoffs (intent, criteria, `riskLabel`), not from a skill.
- **UW-28**: `lunasq install` copies `assets/skills/*/` to `~/.claude/skills/`. A project can override a skill with one of the same name in its `.claude/skills/`.
- The real test is not deterministic: a model may take another path (for example, a reject instead of a pass). That is why the test accepts any valid verdict and only requires the handoff, the transition and the worktree's cleanliness.
