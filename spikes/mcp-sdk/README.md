# Spike — MCP SDK v2 on Hono

Throwaway code. Result and decision in `docs/decisions/0001-mcp-sdk.md`.

```sh
fnm use 26 && pnpm install && pnpm spike
```

`server.ts` mounts `@modelcontextprotocol/server` with `createMcpHonoApp` (stateless Streamable HTTP) and two tools (`echo`, `whoami`); `spike.ts` calls it with `@modelcontextprotocol/client`. Captured output in `output.txt`.
