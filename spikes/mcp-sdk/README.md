# Spike UW-00/a — SDK de MCP v2 en Hono

Código desechable. Resultado y decisión en `docs/decisions/0001-mcp-sdk.md`.

```sh
fnm use 26 && pnpm install && pnpm spike
```

`server.ts` monta `@modelcontextprotocol/server` con `createMcpHonoApp` (Streamable HTTP stateless) y dos tools (`echo`, `whoami`); `spike.ts` lo llama con `@modelcontextprotocol/client`. Salida capturada en `output.txt`.
