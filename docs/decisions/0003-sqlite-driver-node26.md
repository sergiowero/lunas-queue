# 0003 — SQLite driver on Node 26: better-sqlite3 13 with N-API prebuilds

- Status: accepted
- Date: 2026-10-28
- Unit: UW-00 (spike c) · Code: `spikes/sqlite/`

## Context

better-sqlite3 is a native module; `docs/tech-stack.md` asked to confirm precompiled binaries for Node 26 and left `node:sqlite` as plan B behind Drizzle.

## Options

1. **better-sqlite3** + `drizzle-orm/better-sqlite3`.
2. **`node:sqlite`** (`DatabaseSync`) + the corresponding Drizzle driver.

## Spike result

Node 26.13.0 (ABI 147), macOS arm64, pnpm 11.22.0, better-sqlite3 13.0.3, drizzle-orm 0.45.4:

- better-sqlite3 13 ships **N-API prebuilds inside the package** (`prebuilds/{darwin,linux,linuxmusl,win32}-{x64,arm64}.node`), independent of the Node version, and declares `"gypfile": false`.
- pnpm 11 blocks build scripts by default (`ERR_PNPM_IGNORED_BUILDS`, exit 1). If they are allowed, pnpm runs `node-gyp rebuild` only because `binding.gyp` exists (it compiles successfully, but needs a toolchain and is unnecessary). With **`allowBuilds: { better-sqlite3: false }`** the install finishes with exit 0, compiles nothing and the module loads the prebuild.
- With the prebuild: `journal_mode=WAL` confirmed (SQLite 3.53.4), atomic claim with `UPDATE … WHERE state = 'queued'` in `db.transaction()` (the second claim fails), rollback on exception and synchronous transaction with Drizzle over the same connection. Output in `spikes/sqlite/output.txt`; install, prebuilds and `node:sqlite` in `spikes/sqlite/install-log.txt`.
- `node:sqlite` loads on Node 26 without an experimental warning (SQLite 3.54.0), but `DatabaseSync` has no transaction helper and better-sqlite3's advantage does not change.

## Decision

Keep **better-sqlite3** (13.x) with Drizzle. In the root `pnpm-workspace.yaml`, `allowBuilds: { better-sqlite3: false }` is declared when UW-01 adds the dependency, to use the prebuild without compiling. `node:sqlite` remains plan B with no pending work.

## Consequences

- No C++ toolchain is needed in CI or on the machines of users on platforms with a prebuild.
- A platform without a prebuild (e.g. FreeBSD) would require allowing the build; `lunasq doctor` can detect that the module does not load.
- This spike is repeated when better-sqlite3 goes up a major version.
