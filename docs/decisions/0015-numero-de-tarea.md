# 0015 — Task number (#N)

- Status: accepted
- Date: 2026-10-30
- Task: e5f15762-0f14-4b0c-9220-48cf5b882262 · Code: `tasks.number` and `packages/db/drizzle/0008_task_number.sql`, `TaskNumber` and `taskLabel` in `packages/schemas/src/task.ts`, `packages/web/src/components/task-number.tsx`, `packages/web/src/lib/mentions.ts`, `packages/web/src/components/task/intent-text.tsx`

## Context

Tasks were identified only by their UUID. In herdr (pane title, workspace label) and in notifications the first 8 characters of the UUID appeared, hard to read, remember and mention between tasks. A short number was requested to follow tasks, usable with `#` to link them from another task's intent.

## Decision

- **Number in addition to the UUID.** `tasks.number` is a positive integer, sequential and **global** (not per project): `#12` identifies a single task across all of LunasQ, without needing the project. The UUID remains the identity in API and UI routes, foreign keys, branch (`lunasq/<uuid>`), the agent's name in herdr and the evidence file.
- **Assignment.** `TaskRepository.create` takes `max(number) + 1` inside its IMMEDIATE transaction, so two creations do not read the same maximum. The unique index `tasks_number_unique` rejects a duplicate and a CHECK requires a positive integer. Since tasks are not deleted (the project FK is `restrict` and there is no delete API), canceling does not free the number: it is not reused.
- **Immutable.** The trigger `tasks_number_immutable` aborts any UPDATE that changes an already assigned number; neither edits nor transitions touch it.
- **Migration 0008.** `ADD COLUMN` (recreating `tasks` would cascade-delete Runs, edges and usage) and backfill with `row_number()` by `created_at` and `rowid`: existing tasks are numbered from 1 in creation order, without gaps. The column allows NULL in SQL only so that the `tasks_assign_number` trigger completes the inserts that bring no number (writes outside the repository, such as test helpers); every row read has a number and `Task` requires it.
- **Where it is exposed.** `Task`, `DependencyLink`, `TaskGraphNode`, `TaskContext.task` (`get_task_context`) and the `task.created` payload (optional in the schema: earlier events do not carry it).
- **`#N` label.** `taskLabel` builds the label. herdr: pane title `LunasQ <phase> #N` and the task's workspace label `<project> #N`. Notifications (blocked agent, phase timeout, open question, exhausted retries and verification loop) say `in #N` instead of the UUID prefix. The UI shows `#N` next to the intent on the board, queue, DAG, Inbox, dependencies and detail; `web` repeats the helper because it only shares types with `schemas`.
- **Mentions.** In the detail, each `#N` of the intent that corresponds to an existing task is a link to its detail. A mention is `#` and digits with no letter, digit or `#` stuck before and no letter or digit stuck after: `#abc`, `a#5`, `#5x` and `#0` are text, like a number without a task. Where the intent is already inside a link (board cards, queue rows, DAG nodes) it is shown as plain text so as not to nest links.

## Consequences

- Tasks created outside `TaskRepository` receive a number from the trigger; RETURNING does not see it, so whoever inserts via SQL must reread the row.
- `#N` references are not validated or stored as edges: they are intent text that the UI resolves when displaying it.
