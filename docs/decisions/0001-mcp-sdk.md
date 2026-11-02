# 0001 — MCP SDK for TypeScript: the v2 line

- Status: accepted
- Date: 2026-10-28
- Unit: UW-00 (spike a) · Code: `spikes/mcp-sdk/`

## Context

`docs/tech-stack.md` left open whether the LunasQ MCP would use the v2 generation of the official SDK (packages `@modelcontextprotocol/server` and middleware for Hono), pre‑stable during 2026, or the v1.x line (`@modelcontextprotocol/sdk`). The LunasQ MCP runs with the Streamable HTTP transport mounted on Hono and shares Zod v4 schemas with the rest of the backend.

## Options

1. **v2**: `@modelcontextprotocol/server` + `@modelcontextprotocol/hono` (+ `@modelcontextprotocol/client` for tests).
2. **v1.x**: `@modelcontextprotocol/sdk@1.32.2`, which pulls in Express, Hono, ajv and `zod-to-json-schema` as direct dependencies.

## Spike result

- On npm, `latest` of `@modelcontextprotocol/server` and `/client` is **2.4.0** (2026‑10‑23) and of `@modelcontextprotocol/hono` is **2.0.2**; neither is a pre‑release. `server` depends on `zod ^4.2.0`; `hono` has peers `hono ^4.11.4` and `@modelcontextprotocol/server ^2.3.0`.
- A server with `createMcpHonoApp()` + `localhostHostValidation()` and `WebStandardStreamableHTTPServerTransport` in stateless mode (server and transport per request) on `@hono/node-server` 2.1.5, on Node 26.13.0:
  - `listTools` returns the `inputSchema` generated from Zod as JSON Schema draft 2020‑12.
  - `callTool` works; an invalid argument comes back as `isError: true` with the Zod validation error, with no exception in the client.
  - The request headers are available in the Hono handler on every call (basis of spike b).
- Claude Code 2.1.312 also sends `server/discover` before `initialize`; the v2 SDK handles it without extra configuration (see `spikes/run-token/seen-*.ndjson`). The npm versions and dates come from `npm view <package> dist-tags time.modified` as of 2026‑10‑28.

Output in `spikes/mcp-sdk/output.txt`.

## Decision

Use **MCP SDK v2**: `@modelcontextprotocol/server` and `@modelcontextprotocol/hono` in `packages/server`, and `@modelcontextprotocol/client` as a development dependency for UW-15's contract tests. v1.x is discarded.

## Consequences

- Zod v4 stays aligned with the SDK (no `zod-to-json-schema`); the schemas in `packages/schemas` serve directly as `inputSchema`.
- Stateless mode per request: the run token is read from the header on every call, with no MCP session to invalidate. If UW-15 needs server→client notifications, the session mode is revisited.
- Always mount `localhostHostValidation()` (protection against DNS rebinding).
- `docs/tech-stack.md` is updated with the concrete packages.
