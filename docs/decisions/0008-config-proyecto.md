# 0008 — Project configuration

- Status: accepted
- Date: 2026-10-29
- Unit: UW-05 · Code: `packages/schemas/src/project.ts`, `packages/domain/src/project-config.ts`, `packages/db/src/projects.ts`, `packages/server/src/api/projects.ts`

## Context

UW-01 left `agent_profiles` and `limits` as free JSON (ADR 0005) and assigned their shape to UW-05. The design asks for an agent profile per phase (kind, model, args), a concurrency limit per project, a per‑phase timeout with a default of 30 minutes (`docs/design.md` §Concurrency and §Phase timeout) and that the verification profile validate `kind = claude` (§Verification with subagents).

## Decision

- **Profiles.** `agentProfiles` has one key per `Phase` (`refine`, `implement`, `verify`, `deliver`); each profile is `{ kind, model?, args }`. A phase without a profile is filled with `{ kind: "claude", args: [] }`, so an old row with `{}` is still valid. The default does not bring the Auto mode args or the approver's Sonnet model (`docs/design.md` §Decisions made and §Verification): they are configured in each project's profile, and UW-16 decides whether the dispatcher requires or injects the Auto mode args before dispatching. Unknown phases and fields are rejected.
- **Verify tied to claude.** The `verify` profile uses `z.literal("claude")` and not `AgentKind`: when v2 adds other kinds, verification will still require Claude Code until another agent has an equivalent to its subagents.
- **Limits.** `limits = { concurrency?, phaseTimeoutMinutes?, maxVerificationIterations? }`, integers ≥ 1; the iteration cap (from 1 to 20, default 3 with `DEFAULT_MAX_ITERATIONS`) was added by UW-23 ([ADR uw-23-verificacion](uw-23-verificacion.md)); the timeout has a one‑week cap (`MAX_PHASE_TIMEOUT_MINUTES`), because `setTimeout` treats more than 2^31‑1 ms as 1 ms. Without `concurrency` only the global limit applies; a phase without a timeout uses `DEFAULT_PHASE_TIMEOUT_MINUTES` (30). The default is resolved on read (`phaseTimeoutMs`), not stored, so changing it does not require migrating rows.
- **Fields.** `repo` is `owner/name` (what `gh --repo` receives; the owner allows `_` for EMU accounts and the name cannot be `.` or `..`); `localPath` is absolute and normalized (no `//`, `.`, `..` or trailing `/`, by hand because schemas does not import `node:path`) so uniqueness cannot be bypassed with variants of the same path; the root `/` is rejected. It is not checked on disk that it exists or that it is a git repo: that belongs to whoever uses it (worktrees, `lunasq doctor`). `testCommand` and `bootstrap` are optional commands.
- **PATCH.** Each present field replaces the stored one, except `agentProfiles`, which is merged per phase: sending only `verify` keeps the others. `null` clears `testCommand` or `bootstrap`. The update runs in a transaction and validates the resulting row; if it is not valid it is rolled back, and a PATCH can fix a row's invalid phase.
- **Reading without the database.** The domain defines the port `ProjectConfigReader` (`get`, `list`) and the functions `phaseProfile` and `phaseTimeoutMs`. Dispatcher, test gate and hooks depend on the port; `ProjectRepository` (db) implements it and `InMemoryProjectConfigReader` serves in tests. A contract suite (`@lunasq/domain/testing`) runs against both. The readers return copies.
- **Validation in both directions.** The repository parses with Zod what it writes and what it reads; a row with invalid JSON gives `invalid_row` instead of a half object. `list` also fails if any row is invalid: nobody dispatches with a partial list.
- **HTTP errors.** 400 `invalid_json` or `invalid_input` (with Zod's issues), 404 `not_found`, 409 `conflict` (with `field`: `name` or `localPath`) or `has_tasks` when deleting a project with tasks, and 500 in JSON (`invalid_row` or `internal`) for the rest via `app.onError`. `ON DELETE RESTRICT` fails in SQLite with `SQLITE_CONSTRAINT_TRIGGER`, so it is detected by the `FOREIGN KEY` message.

## Consequences

- `hono` enters as a dependency of `server` (it was already in `docs/tech-stack.md`). `@hono/zod-validator` is not used: a manual `safeParse` is enough.
- `@lunasq/db` exports `./test-helpers` and `@lunasq/domain` exports `./testing` so other packages reuse fixtures and the contract; both declare `vitest` as a devDependency.
- `docs/design.md` says the herdr workspace id is stored in Project; that column does not exist and is left for UW-16.
