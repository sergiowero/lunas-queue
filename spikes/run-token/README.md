# Spike UW-00/b — run token por Run vía `--mcp-config`

Código desechable. Resultado y decisión en `docs/decisions/0002-run-token-mcp-config.md`. Reusa `../mcp-sdk/server.ts` (instala dependencias allí primero).

```sh
SEEN_LOG=seen.ndjson node serve.ts &   # MCP en http://127.0.0.1:4518/mcp; registra el header de cada request
claude -p "Llama a la tool whoami del servidor lunasq y responde solo con su texto." \
  --mcp-config mcp-run.json --strict-mcp-config --allowedTools mcp__lunasq__whoami --model haiku
LUNASQ_RUN_TOKEN=run-env-0002 claude -p "…" --mcp-config mcp-run-env.json --strict-mcp-config --allowedTools mcp__lunasq__whoami --model haiku
```

- `mcp-run.json`: token literal en el header (archivo por Run).
- `mcp-run-env.json`: header `${LUNASQ_RUN_TOKEN}`, expandido desde el entorno del proceso.
- `seen-claude-p.ndjson`: requests vistas con `claude -p`; `seen-herdr.ndjson`: requests del agente arrancado con `herdr agent start` (spike d, pasos 07–13).
