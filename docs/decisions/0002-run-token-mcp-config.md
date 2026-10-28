# 0002 — Run token hacia el LunasQ MCP vía `--mcp-config` y variable de entorno

- Estado: aceptada
- Fecha: 2026-10-28
- Unidad: UW-00 (spike b) · Código: `spikes/run-token/` (reusa `spikes/mcp-sdk/server.ts`)

## Contexto

Cada llamada del agente al LunasQ MCP debe llevar el run token del Run, para que una sesión vieja no pueda mover la tarea (`docs/design.md`, MCPs y skills). `docs/tech-stack.md` proponía que el dispatcher generara un archivo de configuración MCP por Run con el token en un header y lo pasara a Claude Code con `--mcp-config`.

## Opciones

1. **Archivo por Run con token literal**: `mcp-<run>.json` con `"headers": { "X-LunasQ-Run-Token": "<token>" }`.
2. **Archivo estable con expansión de entorno**: un solo archivo con `"X-LunasQ-Run-Token": "${LUNASQ_RUN_TOKEN}"`; el token vive solo en el entorno del pane, que el dispatcher ya inyecta (`LUNASQ_RUN_TOKEN`).

## Resultado del spike

Servidor MCP v2 en Hono que registra el header de cada request, Claude Code 2.1.312, flags `--mcp-config <archivo> --strict-mcp-config --allowedTools mcp__lunasq__whoami --model haiku`:

| Prueba | Resultado |
| --- | --- |
| `claude -p` + opción 1 | `whoami` devuelve `run-literal-0001`; el header llega en las 6 requests (`server/discover`, `initialize`, `notifications/initialized`, GET SSE, `tools/list`, `tools/call`) |
| `claude -p` + opción 2 con `LUNASQ_RUN_TOKEN=run-env-0002` | Igual, con `run-env-0002` en las 6 requests |
| `herdr agent start --kind claude -- <mismos flags>` (opción 2) en un pane creado con `pane split --env LUNASQ_RUN_TOKEN=run-herdr-0003` | Los args pasan intactos a `claude`, el env del pane llega al proceso y el header `run-herdr-0003` aparece en las 6 requests |

Evidencia: `spikes/run-token/seen-claude-p.ndjson`, `spikes/run-token/seen-herdr.ndjson`, `spikes/herdr/outputs/07–14`.

## Decisión

**Opción 2.** `lunasq` genera un archivo de configuración MCP estable (por proyecto o por instalación) con el header `X-LunasQ-Run-Token: ${LUNASQ_RUN_TOKEN}`. El dispatcher crea el pane del agente con `LUNASQ_RUN_TOKEN` (y el resto de variables) en su entorno y arranca Claude Code con `--mcp-config <archivo> --strict-mcp-config` en los args del perfil de fase.

## Consecuencias

- El token no se escribe en disco ni hay archivos por Run que crear, limpiar o reconciliar; el despacho sigue siendo idempotente.
- `--strict-mcp-config` aísla al agente de otros MCP del usuario; si una fase necesita otro MCP (p. ej. engram), se agrega al mismo archivo.
- Dependemos de la expansión `${VAR}` de Claude Code en `headers`. `lunasq doctor` y la suite de contrato de UW-16 deben cubrirla; si se rompe, la opción 1 sigue siendo válida y solo cambia quién escribe el archivo.
- El servidor rechaza requests sin header o con token que no corresponda a un Run activo (UW-15).
- `docs/tech-stack.md` se actualiza con esta decisión.
