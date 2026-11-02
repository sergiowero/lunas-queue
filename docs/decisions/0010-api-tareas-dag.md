# 0010 — Tasks API and dependency DAG

- Status: accepted
- Date: 2026-10-29
- Unit: UW-07 · Code: `packages/schemas/src/task.ts`, `packages/domain/src/dependency-graph.ts`, `packages/db/src/tasks.ts`, `packages/server/src/api/tasks.ts`

## Context

`docs/design.md` (§Domain model and §Scheduler) asks for tasks with intent, tags and priority, cancellation and a dependency DAG that rejects edges that close a cycle; the scheduler (UW-13) needs ancestors and descendants. It did not say when edges can be edited, what happens with canceled dependencies or how changes that are not transitions are audited.

## Decision

- **DAG rules in the domain.** `DependencyGraph` (pure TypeScript, immutable) is built from the edges and exposes direct dependencies and dependents, `ancestors` (those it depends on, transitively) and `descendants` (those it blocks: the unblock boost), both by distance and without repetition. `findCycle(edge)` returns the shortest path that the edge would close, from the dependent to itself (`[a, a]` if it depends on itself), or null.
- **Scheduler port.** `DependencyGraphReader.snapshot()` returns the full DAG, including cross‑project edges; the scheduler reads it once per tick. `TaskRepository` implements it and `InMemoryDependencyGraphReader` serves in tests; the contract suite (`@lunasq/domain/testing`) runs against both. In v1 loading all the edges is enough; if it grows, the implementation changes without touching the port.
- **Edges only in draft.** An edge is added only if the dependent is in draft: the design validates dependencies before refining. Removing an edge is allowed in any non‑terminal state. Repeating an existing edge is idempotent: `PUT` answers 200 with no new event, and this is checked before the state, so repeating it on a task that has already left draft also answers 200. A `DELETE` of an edge that does not exist answers 404 without writing anything: the effect is not duplicated, but the caller knows there was no edge.
- **Valid dependencies.** You cannot depend on a canceled task: the dependent would be blocked forever. A completed task is a valid dependency. Cross‑project dependencies are accepted and marked `crossProject` in `GET /api/tasks/:id/dependencies` and in the events (`task.created` and `task.dependency_*`), so the UI shows them as a risk.
- **Concurrency.** Creating tasks, editing and adding or removing edges runs in `IMMEDIATE` transactions: cycle validation reads the edges with the write lock held, so two processes (server and CLI) do not validate at the same time two edges that together would close a cycle. A test with two connections checks it: with the lock held by another, `addDependency` fails without executing any read. `dependencies` reads in a transaction to see a coherent state.
- **Atomic creation.** `POST /api/tasks` accepts `dependsOn` and creates the task, edges and event in the same transaction; if a reference does not exist or is canceled nothing is written. A new task has no dependents, so its initial edges cannot close a cycle. It is born in draft with the sub‑state of `subStateFor("draft")`.
- **Audit.** Every write leaves its event with actor `human`: `task.created` (what was captured, with each initial dependency and its `crossProject`), `task.updated` (only the fields that changed, with `from` and `to`; with no changes there is no event), `task.dependency_added` and `task.dependency_removed` (on the dependent, with `dependsOnId` and `crossProject`). The payloads are in `@lunasq/schemas`.
- **Editing.** `PATCH` changes intent, tags and priority; state, project and read‑only fields are rejected with 400. Terminal tasks are not edited (409 `task_terminal`).
- **Cancellation.** `POST /api/tasks/:id/cancel` (optional note) uses `transitionTask` with `cancel` and actor `human` (ADR 0007). Stopping and cleaning up the live agent belongs to the dispatcher and reconciliation (UW-16, UW-17), which react to the event. There is no `DELETE` of tasks: they are canceled (ADR 0005).
- **Resuming.** `POST /api/tasks/:id/resume` (no body) uses `transitionTask` with `resume` and actor `human`: the task goes back to the state it was escalated from. 409 outside `needs_human`. The front end offers it in the task detail, next to cancel. It does not reset the verification iteration.
- **HTTP errors.** 400 `invalid_json` or `invalid_input`; 404 `not_found` if the route's task does not exist (also when removing an edge that does not exist); 422 if a reference does not exist (`project_not_found`, `dependency_not_found`, `caused_by_not_found`); 409 for `cycle` (with `cycle`, the path), `task_not_draft`, `task_terminal`, `dependency_cancelled` and rejected transitions (`invalid_transition`).

## Consequences

- UW-13 computes the ready set and the boost with `DependencyGraphReader`; what counts as a satisfied dependency (merged PR) is decided by UW-13 with UW-14.
- Canceling a task with dependents leaves them waiting for a dependency that will never be delivered; the design only defines the case of the PR closed without merge (Needs human). Treating cancellation the same way is left for UW-13/UW-14.
- `server/src/api/http.ts` concentrates the route helpers that used to live in `projects.ts`.
