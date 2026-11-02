# 0011 — Event outbox: transactional enqueueing and at-least-once publisher

- Status: accepted
- Date: 2026-10-29
- Unit: UW-08 · Code: `packages/db/src/outbox.ts`, `packages/db/src/event-log.ts`, `packages/server/src/outbox/`, schema in `packages/schemas/src/outbox.ts`

## Context

`docs/design.md` (§Components) asks to publish state changes to the scheduler and the dispatcher without losing events between the database and the queue. UW-01 left the `outbox` table (autoincrement id, unique `event_id`, `topic`, `payload`, `published_at`, `attempts`) and ADR 0007 fixed that the outbox comes from the `task.transitioned` events. UW-08's criterion is that no event is lost on a crash between the commit and the publication.

## Decision

- **Enqueueing in the same transaction.** `appendEvent(db, input, { publish: true })` writes the event and its outbox row in one transaction; inside another one (as in `transitionTask`) it is a savepoint, so it is committed or rolled back together with the caller. `transitionTask` always publishes. If the commit happens, the pending row exists; if not, neither the event nor the state change exists. Other events (e.g. UW-07's `task.created`) choose to publish with the same option.
- **Idempotent.** `enqueueOutbox` ignores an `event_id` that is already enqueued.
- **Topic = event type.** The message (`OutboxMessage` in `@lunasq/schemas`) is built with a join to `events`: `id`, `eventId`, `topic`, `taskId`, `actor`, `payload`, `createdAt`. The `outbox.payload` column stays `NULL` so as not to duplicate the event's payload; each subscriber validates the payload with its topic's schema.
- **In‑process publisher** (`OutboxPublisher`): subscribers per topic or `*`. `drain()` reads pending ones in `id` order, delivers to each subscriber in registration order and waiting for the asynchronous ones, and marks `published_at`. Only one pass at a time: a `drain` or `wake` during another asks for one more pass, and if it arrives when the pass is already exiting, it is relaunched at the end; this way what was committed after the read is not left behind. After a delivery failure there is no extra pass: the retry waits for the next `wake` or poll. `start()` does an initial drain (recovers what a crash left) and starts a periodic poll (1 s by default); `wake()` brings it forward after a commit; `stop()` stops the poll and waits for the message in progress.
- **At‑least‑once and in order.** If the process crashes after delivering and before marking, the message is delivered again on startup. If a subscriber fails, `attempts` is incremented, `onError` is notified and the drain stops so as not to deliver out of order; the next drain retries from that message and redelivers it also to the subscribers that had already received it.
- **No subscribers.** With at least one registered subscriber, a message whose topic has no recipients is marked published. With no subscriber at all the drain marks nothing, so a `start` before registering them does not lose what a crash left.
- **Proof of the criterion.** A child process commits a transition and dies with `SIGKILL` before publishing; a new publisher on the same file delivers it on startup. Another child receives the message and dies inside the handler, before marking it; the next publisher redelivers it. The children run the workspace's TypeScript directly with Node (type stripping, no flags), so the packages' code must be erasable syntax only: `tsconfig.base.json` enables `erasableSyntaxOnly` and the parameter properties of `ProjectRepository`, `TaskRepository` and their errors became declared fields. Node 26 no longer accepts `--experimental-transform-types`.

## Consequences

- The subscribers (UW-13 scheduler, UW-16 dispatcher) must be idempotent for repeated messages; the scheduler is because it recomputes the ready set from the database.
- The unit that composes the server (UW-13 when connecting the scheduler, or the one that mounts the process) creates an `OutboxPublisher`, registers subscribers, calls `start()` and `wake()` after each committed transition; on shutdown, `stop()`.
- A subscriber that always fails blocks the queue (poison message): there is no dead‑letter in v1. `attempts` and `onError` make it visible; if needed, a cap is added that escalates to needs_human or marks the message.
- Retries have no backoff: a message that always fails is retried on every `wake` and every poll, and calls `onError` each time.
- `stop()` waits without limit for the handler in progress; a handler that never resolves blocks shutdown. Subscribers must not be left waiting on I/O without a timeout.
- Published rows are not purged; with v1's volume it is not needed. `published_at` allows purging later.
- One publisher per database. Two processes publishing on the same file could deliver twice; v1 runs in a single process.
