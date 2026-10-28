# 0001 — SDK de MCP para TypeScript: línea v2

- Estado: aceptada
- Fecha: 2026-10-28
- Unidad: UW-00 (spike a) · Código: `spikes/mcp-sdk/`

## Contexto

`docs/tech-stack.md` dejaba abierto si el LunasQ MCP usaría la generación v2 del SDK oficial (paquetes `@modelcontextprotocol/server` y middleware para Hono), pre‑estable durante 2026, o la línea v1.x (`@modelcontextprotocol/sdk`). El LunasQ MCP corre con transporte Streamable HTTP montado en Hono y comparte esquemas Zod v4 con el resto del backend.

## Opciones

1. **v2**: `@modelcontextprotocol/server` + `@modelcontextprotocol/hono` (+ `@modelcontextprotocol/client` para tests).
2. **v1.x**: `@modelcontextprotocol/sdk@1.32.2`, que arrastra Express, Hono, ajv y `zod-to-json-schema` como dependencias directas.

## Resultado del spike

- En npm, `latest` de `@modelcontextprotocol/server` y `/client` es **2.4.0** (2026‑10‑23) y de `@modelcontextprotocol/hono` es **2.0.2**; ninguno es pre‑release. `server` depende de `zod ^4.2.0`; `hono` tiene peer `hono ^4.11.4` y `@modelcontextprotocol/server ^2.3.0`.
- Un servidor con `createMcpHonoApp()` + `localhostHostValidation()` y `WebStandardStreamableHTTPServerTransport` en modo stateless (servidor y transporte por request) sobre `@hono/node-server` 2.1.5, en Node 26.13.0:
  - `listTools` devuelve el `inputSchema` generado desde Zod como JSON Schema draft 2020‑12.
  - `callTool` funciona; un argumento inválido vuelve como `isError: true` con el error de validación de Zod, sin excepción en el cliente.
  - Los headers de la request están disponibles en el handler de Hono en cada llamada (base del spike b).
- Claude Code 2.1.312 envía además `server/discover` antes de `initialize`; el SDK v2 lo atiende sin configuración extra.

Salida en `spikes/mcp-sdk/output.txt`.

## Decisión

Usar **MCP SDK v2**: `@modelcontextprotocol/server` y `@modelcontextprotocol/hono` en `packages/server`, y `@modelcontextprotocol/client` como dependencia de desarrollo para los tests de contrato de UW-15. Se descarta v1.x.

## Consecuencias

- Zod v4 queda alineado con el SDK (sin `zod-to-json-schema`); los esquemas de `packages/schemas` sirven directo como `inputSchema`.
- Modo stateless por request: el run token se lee del header en cada llamada, sin sesión MCP que invalidar. Si UW-15 necesita notificaciones servidor→cliente, se revisa el modo con sesión.
- Montar siempre `localhostHostValidation()` (protección contra DNS rebinding).
- `docs/tech-stack.md` se actualiza con los paquetes concretos.
