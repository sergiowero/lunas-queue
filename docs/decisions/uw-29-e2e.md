# UW-29 — End-to-end pilot and e2e suite

- Status: accepted
- Date: 2026-10-30
- Unit: UW-29 · Code: `packages/e2e/` (`harness/`, `tests/`, `playwright.config.ts`), `packages/server/src/runtime/`, `packages/cli/`

## Context

UW-29 asks for two things: a pilot on a real project (3 tasks with dependencies, a rework, a question and a hook) and a UI e2e suite that runs in CI against a server with herdr's fake. The real pilot needs herdr, Claude Code and `gh` of a specific machine and spends tokens, so it does not run in CI. The suite automates the same script with everything that can be reproduced.

## Decision

- **A complete server, with fakes only where the external stuff is.** `packages/e2e/harness/main.ts` starts `startRuntime` (SQLite database, API, MCP, scheduler, dispatcher, reconciliation, delivery, hooks, PR poller and front end) with `FakeGitHub` and a fake herdr. Everything else is real: git against a bare `origin` in a temporary directory, real worktrees, the test gate (`sh test.sh` in a pane) and the hooks read from `origin/main`.
- **Scripted agent instead of Claude Code.** `ScriptedHerdr` extends `FakeHerdr`: it creates the worktrees with `git worktree add` and, for each prompt an agent receives, runs a script (`harness/agent.ts`) that talks to the real LunasQ MCP with the pane's run token (`get_task_context`, `ask_human`, `submit_spec`, `update_checklist`, `submit_for_verification`, `submit_verdict`), makes a real commit in the worktree and reports the reviewers' `SubagentStart/Stop` hooks. The turn ends with the agent in `done`. The script is decided by the phase and the intent: `[pregunta]` makes refinement ask and `[rework]` makes the first verdict a reject. It tests the server, not Claude Code; what depends on the real model is covered by the manual pilot (`docs/pilot.md`) and each package's `test:claude`.
- **The humans are the browser.** Playwright creates the tasks (with their dependencies), answers the question and approves the specs from the UI. The merge is done by the test through a control server (`POST /merge/:taskId`), as GitHub would: it marks the fake's PR as merged and advances the origin's `main`, and only if the branch is a direct advance of `main` (delivery rebased it); a PR that is not fails the pilot, because it would not be mergeable.
- **Verifiable "mergeable PR" criterion.** The three tasks end in `completed`, with a merged PR in the fake and the origin's `main` advanced by each one. B depends on A and C on B: B and C stay in `draft` and without Runs for several scheduler ticks while their dependency is not merged, and their worktree is born from the already merged base.
- **Seams in `startRuntime`.** To compose the pilot's server without copying the runtime, `RuntimeOptions` adds `webRoot` (front end static files), `prPollIntervalMs` and `scheduler` (`tickIntervalMs`). `lunasq start` passes `webRoot` when it finds the build (`bin/../web` in the published package or `packages/web/dist/app` in the repo) and `buildPackage` builds the front end again and includes the result in `dist/web`.
- **Orderly shutdown.** The `webServer` uses `gracefulShutdown` (SIGTERM) so the harness closes the runtime and deletes its temporary directory; the harness sets a git committer identity and isolates the global config, because delivery rewrites commits and CI has no identity.
- **Playwright is a development dependency of `packages/e2e`** (`@playwright/test`, already listed in `docs/tech-stack.md`). `pnpm e2e` builds the front end and runs the suite serially (`mode: serial`, one worker, no retries): the tests share the server, the database and the DAG, so they depend on order and are not run individually with `--grep`; the CI job installs Chromium and uploads the report if it fails. `packages/e2e` enters the boundaries matrix (`server`, `adapters`, `schemas`; nobody imports it) in `tooling/boundaries.test.ts`, `biome.json` and `docs/tech-stack.md`. Vitest only runs `harness/**/*.test.ts`.

## Pilot findings

They were fixed in this unit:

- **Real herdr:** an agent without a `name` (a Claude Code session opened by hand) made every `snapshot` fail with `invalid_type`. The adapter now tolerates and discards them (finding from [ADR uw-28-instalador](uw-28-instalador.md)).
- **`git fetch` race:** when merging a task, the `after_merge` hook and the released dependent's worktree `fetch` the same `origin/main` ref at once; git aborted the second with "incorrect old value provided" and the hook was left blocked without running scripts (or a visible error). `RealGit.fetch` repeats up to 4 times only on that error.
- **`lunasq start` did not serve the front end:** `startRuntime` did not pass `webRoot` to `createApp` and the UI was left unserved.

The following remain as new tasks, to queue in LunasQ (`docs/pilot.md`):

- **Hooks not connected to their phase (fixed afterwards):** `before_refinement`, `after_refinement`, `before_implementation` and `on_failure` were in the schema and in `docs/design.md`, but nothing ran them, so a hook in any of them did nothing and did not warn. They are now connected: the dispatcher runs the `before_*` ones, `submit_spec` runs `after_refinement` and the `run.failed` event triggers `on_failure` ([ADR uw-10-hooks](uw-10-hooks.md), [ADR uw-16-dispatcher](uw-16-dispatcher.md)).
- **Creating a task does not wake the scheduler:** the task waits until the next tick (30 s by default) to start refinement. The UI shows "queued" without explaining the wait.

## Verification

- `pnpm e2e` (6 Playwright tests, ~25 s): create the 3 tasks with dependencies from the UI and see them in the DAG; the refinement question reaches the Inbox, is answered and the spec is approved; A reaches `completed` with a PR and evidence; the `before_verification` (exit 0) and `after_implementation` (exit 1, `warn`) hooks appear in the hooks view; B waits for A's merge and goes through a reject (2 implementation Runs and 2 verification Runs, iteration 1); C reaches the end; all three end with a merged PR and `after_merge` ran once per task (Event log).
- Unit tests: the herdr adapter discards agents without a name, `startRuntime` serves static files only with `webRoot`, `lunasq start` passes it, the npm package includes `web/`, and the pilot fixture (real git) rejects a PR that is not a direct advance.
- `RealGit.fetch` repeats on the ref race and does not repeat other failures.

## Pending

The pilot on a real project was not run: it needs real herdr, Claude Code and `gh` and spends tokens. It remains as a guide in [pilot.md](../pilot.md), to run once per version; the findings above that were not fixed here are ready to queue as tasks in LunasQ.
