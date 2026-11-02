# UW-21 — Base front end and read routes

- Status: accepted
- Date: 2026-10-29
- Unit: UW-21 · Code: `packages/web/`, `packages/schemas/src/views.ts`, `packages/db/src/task-views.ts`, `packages/server/src/api/views.ts`, `packages/server/src/web/static.ts`

## Context

UW-21's criterion is that a task is created and followed end to end without using the API by hand. `docs/design.md` (§Front end: minimal views, §Consumption and §Audit) asks for a board per project, the global queue ordered by score and a task detail with spec and versions, Runs, Event log, usage and evidence. Until now the API only exposed projects, tasks, DAG and specs. The reads of Runs, events, usage, evidence and queue were missing, and the server did not serve the front end.

## Decision

- **Read routes in `server`.** The unit is assigned to `packages/web`, but without these reads the criterion is not met. They are thin routes over a read‑only repository, `TaskViewRepository` in `db`:
  - `GET /api/queue?projectId=` lists the live tasks. The ready set comes first, in the order and with the score of the domain's `rankReady` and the same `SchedulerConfig` as the scheduler (`createApp({ scheduler })`). Then come the other live tasks, in the order of the task listing (priority and age), with `score: null`. Each entry carries its total usage. The snapshot, the listing and the usage are read in a single transaction, so the ready set matches the state shown.
  - `GET /api/tasks/:id/runs` returns `RunView`, which does not include `runToken`: the token only lives in the pane. It does not include `launchedAt` or `contextReadAt` either, which are internal details of the dispatcher and the MCP.
  - `GET /api/tasks/:id/events` returns the Event log in write order.
  - `GET /api/tasks/:id/usage` sums the `usage_records` in total and per Run. Cost is only summed when all the group's records carry it; otherwise it is `null`, because a partial total would read as complete. Until UW-20 arrives the response is zero.
  - `GET /api/tasks/:id/evidence` looks for `lunasq/tasks/{id}.md` in this order:
    1. In the task's worktree.
    2. If the worktree has already been cleaned up, in the task's branch (`origin/<branch>` and then the local one) inside the project's repo, with the git adapter.
    3. After the merge, when the branch may be deleted, in `origin/<base branch>`.

    The response indicates the origin (`source: worktree | branch | base`) and the path (`<ref>:<path>` in git). The search does no fetch, because a UI read must not touch the network: it uses the refs that the PR poller and delivery already brought. An absent ref or an inaccessible repo count as "it is not there" (`404 evidence_not_found`). The file is written and committed by UW-24.
  - The response schemas live in `@lunasq/schemas` (`views.ts`).
- **Static files.** `createApp({ webRoot })` serves the `packages/web` build with `serveStatic` from `@hono/node-server`. It falls back to `index.html` only on GETs of client routes. `/api`, `/mcp`, `/hooks/subagent`, `/assets` and their subroutes, and routes with a file extension are left out, so their 404s are preserved. The `listen` and the build's path are left for `lunasq start` (UW-28). The build goes to `packages/web/dist/app` because `dist/` also receives `tsc -b`'s declarations.
- **Live updates through SSE.** `GET /api/stream` emits `change` with `{ taskIds }` every time new events appear in the Event log.
  - Every task mutation leaves an event (ADR 0007), so the Event log is enough as a source. The stream queries it every 500 ms with a read by indexed id, without coupling to the outbox publisher, which `createApp` does not compose.
  - The SSE message id is that of the last event: with `Last-Event-ID`, a reconnection recovers what was missed.
  - The front end (`lib/live.ts`) invalidates the lists and the queries of each affected task.
  - The `QueryClient`'s periodic refresh stays at 30 s, as a safety net if the stream drops.
  - The herdr and UI notifications (`notificationRoutes`) remain another stream, and the Inbox (UW-27) will decide whether to mount them.
- **Spec gate in the detail.** To follow the task without the API, the spec panel allows **approving** and **requesting changes** on the latest pending version of a task in `refined`. If a new version arrives while an earlier one is being reviewed, the panel moves to the new one so the gate is not hidden. Editing and approving, together with the unified view of everything that waits for the human, is left for the Inbox (UW-27).
- **Task creation.** The form offers as dependencies the live tasks of all projects. Those of the chosen project appear first, and those of other projects are grouped under «<project> · otro proyecto», because they are a risk (ADR 0010), as in the detail.
- **«En curso» tab.** `/in-progress` («En curso» in the navigation) lists the tasks in `in_progress` of all projects, with any sub‑state, plus any task with a running agent (`subState = running`, also in `verification` or `draft`), with their project, sub‑state and priority, and a project filter like the queue's. It adds no routes: it reads `GET /api/tasks` and filters by state on the client, so the live stream refreshes it by invalidating `["tasks"]`. Without tasks in progress it shows a message instead of the table.
- **State colors.** `StateBadges` paints `in_progress` with the Badge's `info` variant (blue, `--color-info` tokens in `index.css`) so it stands out in the queue, the detail and the DAG; `needs_human` stays in `destructive` and the other states in `secondary`. The queue's State column uses `StateBadges` instead of plain text. The Badge exposes its variant in `data-variant` so tests do not depend on classes.
- **Errors.** The `QueryClient` does not retry 4xx: a 404 is shown immediately.
- **Implementation details.**
  - The TanStack Router routes are defined in code, without the generator plugin, and each page reads its parameters with `getRouteApi`.
  - The shadcn/ui components (button, badge, card, input, table) are written by hand over Tailwind 4, without Radix: none needs complex accessible primitives yet.
  - `web` imports only types from `@lunasq/schemas`. A value import pulls zod into the bundle.
  - Evidence is rendered with `react-markdown`, which does not interpret raw HTML, so the markdown an agent writes cannot inject scripts.
- **Tests.**
  - The new routes are tested in `server` and in `db` against SQLite.
  - The front end is tested with Vitest, Testing Library and jsdom against `FakeApi` (`packages/web/test/fake-api.ts`). It is an in‑memory API typed with the same schemas, which validates with `TaskCreate` and answers the real server's 400, 422 and 409: spec gate, canceling a terminal task and nonexistent references. `web` cannot import `server`, so the fake is not replaced by the real app in these tests.
  - `test/flow.test.tsx` covers the done criterion: creation, refinement, approval, implementation, verification and PR, all from the UI.
  - The end‑to‑end suite against the real server with Playwright belongs to UW-29.

## New dependencies

| Package | Where | Why |
| --- | --- | --- |
| `@hono/node-server` | `server` | `serveStatic` for Node; the same package will provide UW-28's `listen` |
| `@tanstack/react-table` 8.x | `web` | Chosen in tech-stack; line 8 is pinned because 9 changed its API and 8 is the one the team knows |
| `class-variance-authority`, `clsx`, `tailwind-merge` | `web` | Standard shadcn/ui utilities for variants and classes |
| `react-markdown` | `web` | Safe rendering of the evidence file («markdown render» in tech-stack) |
| `@tailwindcss/vite`, `@vitejs/plugin-react` | `web` (dev) | Vite plugins for Tailwind 4 and React |
| `jsdom`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event` | `web` (dev) | Component and flow tests («Vitest + Testing Library» in tech-stack) |

## Consequences

- The queue shows the same score with which the scheduler dispatches, as long as the server and the scheduler share configuration. Whoever composes the server (UW-28) must pass the same `SchedulerConfig` to both.
- `pnpm --filter @lunasq/web dev` brings up Vite with a proxy from `/api` to `LUNASQ_API` (by default `http://localhost:4310`), to develop against a running server.
- The bundle weighs about 550 kB (170 kB gzipped) in a single chunk. For a local tool it is accepted. If it grows, it is split by route.

- **Global header actions.** On the right of the header, outside the tabs nav, go in this order: the «Nueva tarea» button (a link to `/tasks/new` with `buttonVariants({ size: "sm" })`, decorative `+` icon and visible text; it carries `ml-auto` and `shrink-0` and pushes the group to the right), the Settings gear and the theme selector, which is the last. `/tasks/new` is no longer a nav tab; the route and its page do not change. On viewports below `sm` (375 px) the header does not overflow: the «LunasQ» wordmark is hidden (the brand link keeps `aria-label="LunasQ"`) and the padding and gap are reduced; the nav keeps scrolling horizontally.
