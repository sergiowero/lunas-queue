# 0002 — Run token to the LunasQ MCP via `--mcp-config` and an environment variable

- Status: accepted
- Date: 2026-10-28
- Unit: UW-00 (spike b) · Code: `spikes/run-token/` (reuses `spikes/mcp-sdk/server.ts`)

## Context

Every agent call to the LunasQ MCP must carry the Run's run token, so that an old session cannot move the task (`docs/design.md`, MCPs and skills). `docs/tech-stack.md` proposed that the dispatcher generate one MCP configuration file per Run with the token in a header and pass it to Claude Code with `--mcp-config`.

## Options

1. **One file per Run with a literal token**: `mcp-<run>.json` with `"headers": { "X-LunasQ-Run-Token": "<token>" }`.
2. **Stable file with environment expansion**: a single file with `"X-LunasQ-Run-Token": "${LUNASQ_RUN_TOKEN}"`; the token lives only in the pane's environment, which the dispatcher already injects (`LUNASQ_RUN_TOKEN`).

## Spike result

MCP v2 server on Hono that records each request's header, Claude Code 2.1.312, flags `--mcp-config <file> --strict-mcp-config --allowedTools mcp__lunasq__whoami --model haiku`:

| Test | Result |
| --- | --- |
| `claude -p` + option 1 | `whoami` returns `run-literal-0001`; the header arrives in all 6 requests (`server/discover`, `initialize`, `notifications/initialized`, GET SSE, `tools/list`, `tools/call`) |
| `claude -p` + option 2 with `LUNASQ_RUN_TOKEN=run-env-0002` | Same, with `run-env-0002` in the 6 requests |
| `herdr agent start --kind claude -- <same flags>` (option 2) in a pane created with `pane split --env LUNASQ_RUN_TOKEN=run-herdr-0003` | The args pass intact to `claude`, the pane's env reaches the process and the `run-herdr-0003` header appears in the 6 requests |

Evidence: `spikes/run-token/seen-claude-p.ndjson`, `spikes/run-token/seen-herdr.ndjson`, `spikes/herdr/outputs/07–14`.

## Decision

**Option 2.** `lunasq` generates a stable MCP configuration file (per project or per installation) with the header `X-LunasQ-Run-Token: ${LUNASQ_RUN_TOKEN}`. The dispatcher creates the agent's pane with `LUNASQ_RUN_TOKEN` (and the rest of the variables) in its environment and starts Claude Code with `--mcp-config <file> --strict-mcp-config` in the phase profile's args.

## Consequences

- The token is not written to disk and there are no per‑Run files to create, clean up or reconcile; dispatching remains idempotent.
- `--strict-mcp-config` isolates the agent from the user's other MCPs; if a phase needs another MCP (e.g. engram), it is added to the same file.
- We depend on Claude Code's `${VAR}` expansion in `headers`. `lunasq doctor` and UW-16's contract suite must cover it; if it breaks, option 1 is still valid and only who writes the file changes.
- The server rejects requests without a header or with a token that does not match an active Run (UW-15).
- `docs/tech-stack.md` is updated with this decision.
