# Spike — per-Run run token via `--mcp-config`

Throwaway code. Result and decision in `docs/decisions/0002-run-token-mcp-config.md`. Reuses `../mcp-sdk/server.ts` (install dependencies there first).

```sh
SEEN_LOG=seen.ndjson node serve.ts &   # MCP at http://127.0.0.1:4518/mcp; records each request's header
claude -p "Call the lunasq server's whoami tool and answer only with its text." \
  --mcp-config mcp-run.json --strict-mcp-config --allowedTools mcp__lunasq__whoami --model haiku
LUNASQ_RUN_TOKEN=run-env-0002 claude -p "…" --mcp-config mcp-run-env.json --strict-mcp-config --allowedTools mcp__lunasq__whoami --model haiku
```

- `mcp-run.json`: literal token in the header (one file per Run).
- `mcp-run-env.json`: `${LUNASQ_RUN_TOKEN}` header, expanded from the process environment.
- `seen-claude-p.ndjson`: requests seen with `claude -p`; `seen-herdr.ndjson`: requests from the agent started with `herdr agent start` (spike d, steps 07–13).
