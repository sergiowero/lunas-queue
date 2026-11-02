---
name: lunasq-setup
description: Leaves LunasQ ready and running on this machine (Node 26, pnpm install, lunasq install/doctor, lunasq start, front end with Vite). Use it when asked to set up the project, start it, bring up the server or the UI, or diagnose why it is not running.
---

# lunasq-setup

Run the steps in order and stop at the first failure: report it with its output and the action `doctor` proposes. Everything from the repo root.

## 1. Node 26

`package.json` requires `node >=26` (`.node-version`) and `doctor` fails with less. The PATH may bring another Node (`/opt/homebrew/bin/node`).

```sh
node -v          # must be v26.x
```

If it is not 26, use fnm (installed on this machine): `fnm install 26 && fnm use 26`, and repeat the command in the same shell with `eval "$(fnm env)" && fnm use 26 && <command>`. If there is no fnm, tell the user.

## 2. Dependencies

```sh
pnpm install
```

pnpm is pinned in `packageManager`. better-sqlite3 uses prebuilds (it does not compile); if `doctor` says it does not load, it is a platform problem (ADR 0003).

## 3. Machine requirements

```sh
pnpm lunasq doctor
```

It needs herdr ≥ 0.9.5 with its server running, Codex ≥ 2.1.312 and `gh auth login` done. `lunasq install` does not install those three: if they are missing, ask the user to install them (herdr: `herdr status --json`; gh: `gh auth login`).

## 4. Install (once, idempotent)

```sh
pnpm lunasq install [--port <n>]
```

It writes `~/.lunasq/` (`config.json`, `mcp.json`, `Codex-settings.json`, SQLite database) and copies skills/subagents to `~/.Codex/`. Repeating it changes nothing. Then `pnpm lunasq doctor` must come out green (only warnings are acceptable). Default port: 7360.

To avoid touching the real environment: `LUNASQ_HOME=$(mktemp -d) CLAUDE_CONFIG_DIR=$(mktemp -d) pnpm lunasq install` and use the same variables in `doctor` and `start`.

## 5. Start

```sh
pnpm lunasq start
```

It prints `LunasQ at http://127.0.0.1:<port>`; it stops with Ctrl-C. It is a long process: run it in the background (`run_in_background`). Check that it is alive:

```sh
curl -s http://127.0.0.1:7360/api/projects
```

Typical errors: `LunasQ is not installed` → step 4; port in use → `lunasq install --port <other>` or free the port.

## 6. Front end (optional)

`lunasq start` does not mount the front end build today (`webRoot` is not passed from `startRuntime`), so the UI is run with Vite pointing at the server:

```sh
LUNASQ_API=http://127.0.0.1:7360 pnpm --filter @lunasq/web dev
```

`LUNASQ_API` is necessary: the proxy in `vite.config.ts` uses 4310 by default, not `start`'s 7360. Vite prints the URL (normally `http://localhost:5173`).

## Repo verification

Before a PR (see `AGENTS.md`): `pnpm typecheck && pnpm lint && pnpm test`. Tests against real herdr/Codex/gh, separately: `pnpm --filter @lunasq/server test:herdr` (also `test:Codex`, `test:usage`, `test:skills`).
