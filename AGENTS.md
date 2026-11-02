# AGENTS.md — LunasQ

LunasQ (repository `lunas-queue`) is a multi‑project task queue that dispatches coding agents (Claude Code in v1) through herdr: they refine, implement, verify and deliver each task as a PR, with human gates on the spec and on the merge.

This file says how to work in the repo. The detail lives in `docs/`; read it before changing anything it describes.

## Reference documents

| File | What it contains | When to read it |
| --- | --- | --- |
| `docs/design.md` | Full design: domain model, state machine, dispatcher, MCP, verification, hooks, audit | Before changing anything it describes |
| `docs/tech-stack.md` | Stack, monorepo packages and their boundaries, external integrations, tooling | Before adding dependencies or creating files in a package |
| `docs/decisions/` | Short ADRs with decisions made during implementation | Before contradicting something in the documents above |

The repo is the source of truth. If a decision changes while you implement, update the corresponding `.md` in the same PR as the code. A new ADR goes in `docs/decisions/<topic>.md`.

## Architecture rules

- **Modular monolith in pnpm workspaces.** Packages: `schemas`, `domain`, `db`, `adapters`, `server`, `web`, `cli`, plus `assets/skills` and `assets/agents`.
- **Dependency boundaries** (detail in `docs/tech-stack.md`):
  - `domain` only depends on `schemas` and knows nothing about the database, HTTP, herdr or `gh`.
  - `adapters` isolates everything external (herdr, `gh`, git, process execution) and includes a fake for each adapter.
  - `server` composes everything; `web` only shares types from `schemas`.
  - Never import from a package «upwards».
- **Schemas in one place.** Entities, handoffs and events are defined with Zod v4 in `packages/schemas`; the JSON Schema is generated from there.
- **The database is the truth.** herdr is ephemeral state; any logic that depends on it must be reconcilable.
- **Idempotency.** Dispatches, worktrees, hooks and writes must be repeatable without duplicating effects.
- **No new dependencies without a reason.** If you add one that is not in `docs/tech-stack.md`, justify it in the PR or in an ADR.
- **Language.** The repo is written in English: code, comments, tests, docs, ADRs, skills, and the messages of the API, the MCP and the CLI. Only the UI is bilingual (Spanish by default, with an ES/EN button in the header); its texts live in the front end's dictionaries (`packages/web/src/lib/dictionary/`) and a new UI text goes into both. See `docs/decisions/i18n-es-en.md`.

## Stack and commands

Strict TypeScript on Node.js 26 LTS, pnpm, SQLite (better-sqlite3 + Drizzle), Hono, the official MCP SDK, React + Vite, Vitest, Playwright and Biome.

| Action | Command |
| --- | --- |
| Install | `pnpm install` |
| Tests | `pnpm test` |
| Tests of one package | `pnpm --filter <package> test` |
| Lint and format | `pnpm lint` / `pnpm format` |
| Types | `pnpm typecheck` |
| End-to-end | `pnpm e2e` |

Before opening a PR, `pnpm typecheck`, `pnpm lint` and `pnpm test` must pass. Tests against real herdr and `gh` run separately; run them when you change an adapter.
