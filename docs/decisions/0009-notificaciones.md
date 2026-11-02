# 0009 — Notifications: deterministic id, in-memory deduplication and two channels

- Status: accepted
- Date: 2026-10-29
- Unit: UW-06 · Code: `packages/server/src/notifications/`, schema in `packages/schemas/src/notification.ts`

## Context

`docs/design.md` (Signals, Human‑in‑the‑loop and Decisions) asks to alert the human through herdr and the UI in four cases: open Question and `blocked` agent (if they stay that way after 1 minute), and phase timeout and exhausted verification loop (immediately). UW-06's criterion is that a notification arrives through both channels without being duplicated. There is no notifications table (UW-01) and the Event log (UW-04, ADR 0007) only records task transitions. ADR 0004 left pending what to do with `[ui.toast] delivery = "off"`, herdr's default.

## Decision

- **`Notification`** in `@lunasq/schemas`: `id`, `kind` (`question_open | agent_blocked | phase_timeout | verification_exhausted`), `taskId`, `runId?`, `title`, `body`, `createdAt`. The `id` is built by whoever emits it from the situation (e.g. `question:<questionId>`, `blocked:<runId>:<n>`) and is the deduplication key in all channels.
- **`NotificationService.notify`** validates, discards an `id` already delivered and distributes to each channel in parallel. The `id` is marked before waiting for the channels, so two concurrent calls deliver only once. A channel that fails is reported with `onChannelError` and does not prevent the others. If at least one channel delivered, the id stays as delivered and the channel that failed is not retried. If none delivered, the id is released and a later notice with the same id retries.
- **Channels:** `herdrChannel` (`notification show` with `sound: request`) and `hubChannel` (in‑memory hub towards the UI).
- **SSE** at `GET /stream` (mounted under `/api/notifications` when the server is composed): each notification is an `event: notification` with an `id:` equal to the notification's. The hub keeps the last 100. A reconnection with `Last-Event-ID` receives only what came later. If that id has already left the buffer, it receives the whole buffer, which is all later.
- **`Escalator`**: `watch(pending, { since? })` notifies 60 s after `since` (by default, now) and `resolve(id)` cancels it. Repeating `watch` with a watched id does not restart the deadline, and with an already escalated id it does nothing until `resolve`. `escalated()` lists what was escalated and unresolved. `since` allows re‑arming from the DB after a restart (e.g. with the Question's `createdAt`). The phase timeout and the exhausted loop call `notify` directly.
- **In‑memory deduplication.** After a process restart a notification may repeat once. It is accepted in v1: it is a minor nuisance and does not affect any task's state.
- **Toast off.** If herdr answers `shown: false`, the herdr channel reports it as a channel error (with the `reason`) and the UI receives it anyway. `lunasq install` does not change herdr's configuration; `lunasq doctor` (UW-28) warns if `ui.toast.delivery` is `off`.

## Consequences

- UW-17 calls `watch` on seeing `blocked` and `resolve` on leaving that state; when reconciling, it re‑arms with `since` whatever is still pending in the DB. For a second `blocked` of the same Run it uses another `id` (the `<n>` counter), or deduplication silences it.
- UW-22 does the same with each open Question and calls `resolve` when it is answered.
- UW-21/UW-27 consume the SSE stream and can deduplicate by `id` if they need to; the server no longer resends what was seen.
- If deduplication needs to survive restarts, each notification is recorded in the Event log (UW-04) and the service checks there before delivering.
- The SSE stream sends no keepalive and does not bound a slow client's pending writes; with v1's volume on `localhost` it is not needed. If UW-21/UW-27 need it, a `:` comment is added every ~30 s.
- Releasing the subscription when the client disconnects is only tested with `app.request`. The unit that mounts `/api/notifications` on `@hono/node-server` adds a test with a real HTTP server that disconnects the client.
- The set of delivered ids grows with each notification of the process; with v1's volume (tens per day) it is not bounded.
