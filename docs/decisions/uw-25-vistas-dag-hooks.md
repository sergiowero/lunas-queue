# UW-25 — DAG view (retired) and hooks views

- Status: partial; the DAG view was retired on 2026-10-31 and the hooks view remains active
- Date: 2026-10-30
- Unit: UW-25 · Historical record of the DAG and still‑active hooks decisions

## Context

`docs/design.md` asks for a dependency DAG view and a per‑project hooks view (content of `lunasq/hooks/` in the base branch and latest executions per task). ADR uw-10-hooks left `HookService.listHooks` and the `hook.executed` events, and left the routes and the view for this unit. They did not fix what shape the graph has, what happens with cross‑project dependencies or where the executions come from.

## Decision

- **The graph is the rows of `task_dependencies`.** `GET /api/graph[?projectId=]` returns `{ nodes, edges }`; the front end does not derive edges from other responses. With `projectId`, the nodes are the project's tasks plus those of other projects at the other end of one of its edges, so a cross‑project dependency is not left with a missing end. Without it, all tasks. Terminal ones are included: an already fulfilled dependency is still part of the DAG's history. Nodes and edges are read in a single transaction.
- **Layout with dagre from left to right** (`layoutGraph`, pure function with tests): the arrow goes from what must be finished to what waits for it. The nodes have a known fixed size, so React Flow draws them without measuring them. The `@dagrejs/dagre` dependency is the maintained dagre that `docs/tech-stack.md` already foresaw; `@xyflow/react` was also in the stack.
- **Accessible dependency list next to the graph.** It repeats each edge as «A depende de B» and marks the cross‑project ones. It is the text equivalent of the canvas, which screen readers do not traverse, and what the tests verify: jsdom does not measure React Flow's handles and does not draw the SVG edges.
- **Hooks: `GET /api/projects/:id/hooks`** returns `HookService.listHooks` (scripts, policy, timeout and content from the base branch, `baseRef` and `configError`). It is a git read with `fetch`, so a failure (no network, no base branch) answers 502 `hooks_unavailable` and the view shows it; without a hooks service in `createApp`, 503. An unknown project is 404.
- **Executions: `GET /api/projects/:id/hooks/executions?limit=`** comes from the Event log (`hook.executed` of the project's tasks), not from a new table: it is the same source the evidence file will use. The query (window functions over `json_extract` of the payload) leaves the most recent execution of each task at each point and script, and at most `limit` tasks per hook (10 by default, 100 at most). The cap is per hook and not per project, so a hook that runs rarely (`after_merge`) does not disappear behind other hooks' events. A payload that does not satisfy the schema is skipped. While loading or if the query fails, each hook's card says so instead of claiming «Sin ejecuciones». A script with executions that is no longer in the base branch is shown marked «ya no está en la rama base».
- **Read‑only.** No route edits hooks or edges; hooks are changed through a PR and the edges remain in `PUT/DELETE /api/tasks/:id/dependencies/:dependsOnId` (UW-07).
- **Refresh.** A `change` of the SSE stream invalidates the graph and the hook executions. The hooks' content comes from git, not from events, and is not invalidated: it refreshes when the view is reopened.

## Consequences

- The DAG view's decisions and consequences describe the historical implementation, not an active feature.
- Opening the hooks view does a `fetch` to the project's remote, like each hook point; with many projects and no network the view answers 502 per project, not globally.
- The global graph grows with the number of tasks. With hundreds of nodes, dagre's layout in the browser will be the first thing to be noticed; if it happens, it is filtered by project (already supported) or finished work is hidden.
- React Flow and dagre weigh about 226 kB (74 kB compressed); the DAG page is loaded with `lazyRouteComponent`, so the other views do not download them.
