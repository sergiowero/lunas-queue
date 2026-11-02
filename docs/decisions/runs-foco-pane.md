# Pane focus from the Runs tables

- Status: accepted
- Date: 2026-11-01
- Code: `packages/server/src/api/runs.ts`, `packages/web/src/components/pane-focus-button.tsx`, `packages/web/src/components/task/runs.tsx`, `packages/web/src/pages/in-progress.tsx`

## Context

The detail's Runs panel and the «En curso» tab show each Run's pane id, but to reach the agent the human had to copy the id and look it up in herdr. The Inbox already focuses blocked agents ([ADR uw-27-bandeja](uw-27-bandeja.md)) with `HerdrAdapter.focusAgent`, but only for those that the `RunWatcher` sees as blocked.

## Decision

- **The pane id is a button** that focuses the Run's agent in herdr. The Runs panel and «En curso» (each task's latest Run) share it through `PaneFocusButton`.
- **Route `POST /api/runs/:runId/focus`.** It receives the `runId` and resolves the agent name from the database (`Run.herdrName`), so the UI cannot move herdr to an arbitrary agent: only agents of Runs registered by LunasQ are focused. It reuses the `focus` that `startRuntime` already passes to `createApp`.
- **Responses:** 204; 404 `not_found` if the Run does not exist; 409 `no_pane` if it has no `herdrPane` or `herdrName`; 409 `agent_gone` if herdr does not have the agent (`agent_not_found`); 502 `herdr_error` on any other herdr failure; 503 `focus_unavailable` without herdr. The route writes neither to the database nor to the Event log: it is repeatable.
- **UI.** A Run without a pane or without an agent name keeps «—» as text, without a button; in «En curso», «…» and «error» remain text. The button is disabled while the request is in progress and a failure is shown next to that pane, without touching the rest of the table. Its accessible name is «Enfocar pane <id> en herdr».
- **No refresh after an error.** Unlike the Inbox, the tables read the database, not the `RunWatcher`'s in‑memory state: an `agent_gone` leaves no stale data to refresh. A closed Run keeps showing its pane id (historical) and focusing it answers `agent_gone`.
- `FakeApi` supports the route with the same rejections and records the focused agent in `focused`.

## Consequences

- The panes of already finished Runs are also buttons; on clicking, the human sees "it is no longer in herdr" instead of an inert id.
- As in the Inbox, the focus moves the herdr of the server's machine. If the UI runs on another machine, the button is useless and the human uses `herdr agent focus <name>`.
