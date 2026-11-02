# 0015 — The Inbox lists the specs to approve and the gate lives in the detail

- Status: accepted
- Date: 2026-10-30
- Supersedes: the decision in [ADR uw-27-bandeja](uw-27-bandeja.md) to mount `SpecVersions` in the Inbox
- Code: `packages/web/src/pages/inbox.tsx`, `packages/web/src/components/task/spec.tsx`

## Context

ADR uw-27-bandeja mounted each spec's full panel (versions, content, diff and gate) in «Specs por aprobar». With several tasks in `refined` the Inbox becomes a long page that is hard to scan: the human asked for the section to be just a list to choose what to review.

## Decision

- **«Specs por aprobar» is a list.** One row (`li`) per task in `refined`, ordered as before (`updatedAt` ascending), with the intent as a link to `/tasks/$taskId` and the project name. No versions, content, diff or buttons.
- **The gate lives only in the task detail.** Approve, request changes and edit and approve are done in the detail's «Spec» section, with the same `SpecVersions` and the same behavior (ADR 0013, uw-27-bandeja §Errors). When the task leaves `refined` it stops appearing in the list.
- **The Inbox does not request specs.** Since it does not mount `SpecVersions`, it does not do `GET /api/tasks/:id/specs` per task; the list comes from `GET /api/tasks`, as before.
- **No changes** in the section's loading, error and empty states, in the menu total (it still counts the tasks in `refined`) or in the questions and blocks sections.

## Consequences

- Reviewing a spec from the Inbox costs one more click, in exchange for an Inbox that can be scanned at a glance.
- The gate's tests (edit and approve, invalid JSON, server issues, error of the last action) live in `task-detail.test.tsx`; `inbox.test.tsx` covers the list, the navigation to the detail and that the task leaves the Inbox after deciding.
