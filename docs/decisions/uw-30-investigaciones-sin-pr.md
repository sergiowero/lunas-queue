# UW-30 — Research tasks complete without a PR

- Status: accepted
- Date: 2026-11-02
- Unit: UW-30 · Code: `assets/skills/`, `packages/cli/src/`, `packages/db/`, `packages/domain/src/dispatch.ts`, `packages/schemas/`, `packages/server/src/mcp/`, `packages/web/src/components/task/spec.tsx`

## Context

Task #29 was an investigation, but the refiner wrote a repository report and the task ended in a documentation-only PR. The `submit_result` path already existed, but the installed Claude Code skills were stale: `lunasq install` copied them while `lunasq start` did not check or synchronize assets. The short refinement dispatch prompt also did not mention `submit_result`. The server accepted a documentation-only implementation diff without checking whether the human had approved that deliverable.

## Decision

- **Synchronize assets on startup.** `install` and `start` share one idempotent asset sync. `start` runs it before the server runtime, reports updated assets, and warns about foreign destinations without changing them. The manifest continues to identify destinations LunasQ owns.
- **Make text results explicit.** Refinement instructions and its dispatch prompt send investigations, analysis and synthesis through `submit_result`, with the findings in the Result. They do not create report files or documentation links. The `AGENTS.md` rule to update documentation applies when a code task changes a documented decision.
- **Approve documentation deliverables visibly.** A refinement spec carries `deliverable: "code" | "docs"`, defaulting to `code` for older handoffs and stored specs. SQLite stores it in `specs.deliverable` with a `code` default and an enum check, so the migration preserves existing versions. `docs` is only for repository documentation the human explicitly requested. The spec panel and version diff show the value.
- **Guard implementation delivery.** Before running the test gate, `submit_for_verification` checks committed paths against the task's base. A non-empty diff made only of Markdown files or files under `docs/`, excluding `lunasq/tasks/`, is rejected with `docs_only_diff` when the approved deliverable is `code`. A mixed diff or an approved `docs` deliverable can proceed. If Git cannot report changed paths, the tool fails closed.
- **Keep verification consistent.** The verifier rejects a documentation-only diff when the approved spec says `code`.

## Consequences

- New skills reach existing installations on the next `lunasq start`; foreign folders with matching skill names remain untouched and are reported.
- A research Result has no repository diff or PR. If an implementation branch already contains only a research report, the agent must remove those report-only changes and commits before submitting the Result; it must ask a human before rewriting a branch containing other work.
- A task for documentation must declare `docs` in the approved spec, so the human can distinguish it from research before implementation.
- The JSON Schema, phase skills, server guard, UI translations and automated tests must change together when this contract changes.
