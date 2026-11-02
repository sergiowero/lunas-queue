# 0005 — SQLite schema conventions

- Status: accepted
- Date: 2026-10-28
- Unit: UW-01 · Code: `packages/db/src/schema.ts`, `packages/db/drizzle/`, `packages/schemas/src/enums.ts`

## Context

UW-01 creates the nine tables of the domain model (`docs/design.md`, Domain model and Consumption). Several shape decisions were not written down and the following units (UW-04, UW-05, UW-07, UW-08, UW-12, UW-15, UW-20) inherit them.

## Decision

- **Ids.** Text with UUID v4 (`crypto.randomUUID()`) generated in the application. `events` and `outbox` use an autoincrement integer: they give a total order that the Event log and the publisher need. The UUID id has no SQL default: a write outside Drizzle must generate it.
- **Times.** Integers in epoch milliseconds (`timestamp_ms` in Drizzle). The default lives in SQL (`unixepoch('subsec') * 1000`), so it also applies to writes outside Drizzle; `updated_at` is renewed only from Drizzle on update; a raw SQL `UPDATE` leaves it as is.
- **Enums.** The values are defined once with Zod in `@lunasq/schemas` (`TaskState`, `SubState`, `Phase`, etc.). `db` uses them for the column type and for one `CHECK … IN (…)` per column, because Drizzle does not generate those CHECKs on its own. Adding a value implies a migration.
- **Priority.** `CHECK (typeof(priority) = 'integer' AND priority BETWEEN 0 AND 9007199254740991)`: unsigned integer up to `Number.MAX_SAFE_INTEGER`, because the column is read as a `number`. Without `typeof`, SQLite would accept reals. Counters (tokens, iterations, outbox attempts) use the same CHECK without a cap.
- **JSON.** Text columns in Drizzle's JSON mode, with SQL defaults (`'{}'`, `'[]'`). Their shape is validated by the owning units (project profile and limits in UW-05, spec in UW-12, handoff in UW-03).
- **Sub‑state.** Nullable: only states with an agent have one (default `queued` when born in Draft). The database does not tie `sub_state` to `state`; that coherence belongs to the state machine (UW-04).
- **Deletion.** A project with tasks cannot be deleted (`restrict`). The Event log is append‑only: a task with events cannot be deleted either (`restrict`), so in practice tasks are canceled, not deleted. If a task without events is deleted, it cascades to its edges, specs, runs, questions and usage; `caused_by` and `questions.run_id` become NULL if their reference disappears.
- **Active Run.** Partial unique index `runs(task_id) WHERE ended_at IS NULL`: at most one open Run per task, so a duplicate dispatch fails in the database. Closing a Run means setting `ended_at`. Each Run stores `model` and `iteration` (the task's verification iteration at dispatch) to separate rework from retries in the audit and in consumption.
- **Idempotent consumption.** `usage_records.source_ref` (message or request id in the source) is unique per `(run_id, source, source_ref)`; re‑ingesting the same batch does not duplicate tokens. Without `source_ref` there is no deduplication.
- **Approved spec.** The database does not prevent two approved versions of the same task; that rule and its index, if needed, belong to UW-12.
- **Migrations.** drizzle-kit generates the SQL and the snapshots in `packages/db/drizzle/` (`pnpm --filter @lunasq/db db:generate`). A test regenerates against the schema in a temporary directory and fails if there are changes without a migration.
- **Install without build scripts.** Besides `better-sqlite3` (ADR 0003), `allowBuilds` declares `esbuild: false`: drizzle-kit brings it and resolves its binary from the `@esbuild/<platform>` package without a postinstall.
- **Biome.** Ignores `pnpm-lock.yaml` and `packages/db/drizzle/`: they are generated and their tools rewrite them in their own format.

## Consequences

- The following units import tables and `openDatabase`/`migrateDatabase` from `@lunasq/db`, and the enums from `@lunasq/schemas`.
- A schema change always comes with its generated migration; the sync test enforces it in CI.
