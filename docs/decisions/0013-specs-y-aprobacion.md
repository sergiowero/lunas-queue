# 0013 — Versioned specs and approval gate

- Status: accepted
- Date: 2026-10-29
- Unit: UW-12 · Code: `packages/schemas/src/spec.ts`, `packages/domain/src/spec-diff.ts`, `packages/db/src/specs.ts`, `packages/db/drizzle/0002_specs_aprobacion.sql`, `packages/server/src/api/specs.ts`

## Context

`docs/design.md` (§Domain model and §Human‑in‑the‑loop) asks for versioned specs with a domain model, an approval tied to a specific version, requesting changes with comments, editing and approving, and a diff between versions. ADR 0007 leaves the facts of the `specComplete`, `hasComments` and `specApproved` guards to UW-12. The design did not say which version can be approved, how to record who wrote each version or what happens to the version the human edited.

## Decision

- **A single content schema.** `SpecContent` (domain model, requirements, criteria and task list) uses the same shape and the same reference rules as the refinement handoff's body (`specContentShape`, `checkSpecReferences`). The rules require unique keys in everything the diff compares by key: criterion and task ids, glossary terms and aggregate and event names. This also makes the refinement handoff stricter. Assumptions go in the handoff, not in the spec. The `acceptance_criteria` column stores the handoff's criteria (`id`, `given`, `when`, `outcome`), not UW-01's provisional `{id, text}`.
- **Versions.** Each refiner delivery creates version `max + 1` of the task. The writes run in an `IMMEDIATE` transaction that stores the version, its event and the task's transition with `applyTransition`. `applyTransition` is the body of `transitionTask`, extracted to run inside an open transaction. If the state machine rejects, the transaction is rolled back and there is no version, event or approval change.
- **Decisions only on the latest pending version.** Approving, requesting changes or editing a version that is not the latest answers `stale_version`. If the version has already been approved or already has changes requested, it answers `spec_not_pending`. This way the approval is tied to the version the human saw, and repeating a decision does not duplicate effects.
- **One approved per task.** The partial unique index `specs_one_approved_per_task` guarantees it in the database. `approved(taskId)` is the version implementation and verification read (UW-15).
- **Requesting changes.** The version stays in `changes_requested` with the trimmed comments in `review_comments`, and the task goes from refined to draft/queued. The comments also go in the `spec.changes_requested` event. Without comments, the `hasComments` guard rejects and nothing is written.
- **Edit and approve.** The human starts from the latest pending version. The next version is created with a human author, already approved, in the same step. The base version stays `pending` and superseded: it cannot be approved because it is no longer the latest.
- **Author.** The `created_by` column (actor, default `agent`, with CHECK) says whether the version was written by the refiner or the human. `approved_by` is always `human` in v1 and only `SpecRepository` writes it. It is typed with the actor enum, but without a CHECK: adding it forces recreating the table in SQLite, and it is not worth it for a fixed value.
- **Events.** `spec.version_created` (`specId`, `version`, `basedOn`, with the author as actor), `spec.approved` and `spec.changes_requested`. Their payloads are validated with their schema before being written. They are written before the `task.transitioned` of the same write. Only `task.transitioned` goes to the outbox.
- **Diff.** `diffSpecContent` (pure domain) compares criteria, tasks, terms, aggregates and events by key (added, removed and changed) and requirements and invariants by text. Reordering is not a change. By default it compares against the previous version; the first version appears entirely as added.
- **Migration.** `0002_specs_aprobacion` was edited by hand. drizzle-kit recreated the table and copied `created_by` from the old table, which does not have it. `ADD COLUMN` with its CHECK and the partial index are enough, and the snapshot stays equal to the schema.
- **HTTP.** Under `/api/tasks/:id/specs`:
  - `GET /`, `GET /:version` and `GET /:version/diff?against=`.
  - `POST /:version/approve`, `POST /:version/request-changes` (`{comments}`) and `POST /:version/edit-and-approve` (`{content}`).
  - The actions answer `{spec, task}`.
  - Errors: 400 `invalid_json` or `invalid_input` (also with a version that is not a positive integer); 404 if the task or the version does not exist; 409 for `stale_version`, `spec_not_pending` and rejected transitions.
  - Repeating a decision does not duplicate effects, but answers 409, not 200: `spec_not_pending` when repeating approve or request changes, and `stale_version` when retrying edit and approve, because the base version was already superseded by the edited one. If a client loses the response, it rereads the version with `GET` to know whether its action was applied; UW-21 and UW-27 do it this way.
  - The refiner's version does not come in over HTTP but through the LunasQ MCP's `submit_spec` (UW-15), which uses `SpecRepository.submit`.

## Consequences

- UW-15 validates the handoff with `parseHandoff` and calls `SpecRepository.submit` with the body without assumptions. `get_task_context` reads `approved()` and, in a new refinement round, the comments of the latest version with `changes_requested`.
- UW-21 and UW-27 show versions, author, diff and the gate's three actions with these routes.
- Versions superseded by an edit stay `pending`. The UI must show only the latest as decidable.
