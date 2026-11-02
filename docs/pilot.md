# LunasQ pilot

The pilot has two parts. The e2e suite (`pnpm e2e`, [ADR uw-29-e2e](decisions/uw-29-e2e.md)) automates the script with a scripted agent and runs in CI. This guide is the other part: the same script on a real project, with real herdr and Claude Code. It spends tokens and needs your machine, so it is run by hand, once per version.

## Before starting

1. `lunasq install` and `lunasq doctor` green (no failures).
2. A test repo on GitHub, cloned locally, with a valid `gh auth status` and a test command that passes.
3. In that repo, on the base branch, `lunasq/hooks/before_verification/10-smoke.sh` (executable, `echo ok`) and `lunasq/hooks/after_implementation/10-lint.sh` (fails with `exit 1`) with `{"after_implementation": {"10-lint.sh": {"policy": "warn"}}}` in `lunasq/hooks/config`. Only the points that `docs/decisions/uw-29-e2e.md` lists as connected run.
4. `lunasq start` and open the URL it prints.

## Script

1. Create the project (`POST /api/projects`: repo, base branch, local path and test command).
2. Create three tasks from **Nueva tarea**: A, B (depends on A) and C (depends on B). Make A ambiguous to force a question.
3. **Question:** answer in the **Bandeja** when the refiner asks; then open A from «Specs por aprobar» in the Inbox and approve its spec in the task detail. Check that the agent resumes with your answer.
4. **Dependencies:** B and C do not start until the previous one's PR is merged. Merge A's PR on GitHub and check that B advances on the next poll.
5. **Rework:** on B, open B from the Inbox and reject something in the spec (**Pedir cambios**) or let the verifier reject; check that it goes back to implementation with the must-fixes and that the iteration goes up.
6. **Hook:** in the project's **Hooks**, check the execution of `10-smoke.sh` and that `10-lint.sh` failed without stopping the phase.
7. Merge B and C. Each task must end in a mergeable PR (rebased onto the base, with evidence and risk label).

## What to record

Each deviation from the script is a finding. Turn it into a LunasQ task (intent with the symptom, the script step and what you expected) and link it with **originated by** to the task where it appeared.

## e2e suite findings (ready to queue)

- **Connect the missing hooks:** `before_refinement`, `after_refinement`, `before_implementation` and `on_failure` are in the schema and in `docs/design.md` §Per-phase hooks, but no module runs them. Connect them to their phase (dispatcher and MCP, like `before_verification`) and test each point.
- **Wake the scheduler when a task is created:** today a new task waits for the next tick (30 s). `POST /api/tasks` should wake it, as answering a question already does.
