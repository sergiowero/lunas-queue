# UW-20 — Usage collector: receptor OTLP y Task.usage

- Estado: aceptada
- Fecha: 2026-10-30
- Unidad: UW-20 · Código: `packages/server/src/usage/`, `packages/schemas/src/usage.ts`, `packages/db/src/usage.ts`, `packages/db/drizzle/0006_usage_agent_id.sql`, `telemetryRunEnv` en `packages/domain/src/dispatch.ts`

## Contexto

`docs/design.md` (§Consumo) pide que cada tarea muestre tokens y costo como propiedad de solo lectura, agregada desde los UsageRecords de sus Runs, con desglose por fase, agente, modelo y revisor. UW-28 ya dejaba en el pane las variables OTLP generales y `UsageRecord` ya existía en la base (ADR 0005); faltaban los endpoints, los atributos por Run y los desgloses. El criterio de UW-20: el usage de una tarea coincide con lo que reporta Claude Code.

## Resultado del spike

Con Claude Code 2.1.314 y un receptor local de `http/json`:

- Los atributos de `OTEL_RESOURCE_ATTRIBUTES` llegan en el resource de cada lote y en los atributos de cada log y de cada punto de métrica.
- Las métricas `claude_code.token.usage` y `claude_code.cost.usage` son **delta** (`aggregationTemporality: 1`) y no traen id de request.
- El log `api_request` trae por llamada `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd` y `request_id`; según la documentación de Claude Code también `agent_id` si la hizo un subagente (v2.1.310 o posterior). `agent.name` de un subagente propio vale `custom`, así que no sirve para distinguir revisores.
- Los tokens llegan como `intValue` numérico y el costo como `doubleValue`.

## Decisión

- **Fuente: el evento `api_request`.** Cada llamada es un UsageRecord con `source = otel` y `source_ref = request_id`. Si Claude Code reenvía un lote, el índice único `(run_id, source, source_ref)` (ADR 0005) lo absorbe. Las métricas se descartan: son delta y sin request id, así que reenviarlas duplicaría el consumo y no hay cómo deduplicarlas. `POST /v1/metrics` existe para que el exportador reciba 200, y no hace nada.
- **Autenticación por run token.** El dispatcher agrega al pane `OTEL_EXPORTER_OTLP_HEADERS=X-LunasQ-Run-Token=<token>` y `OTEL_RESOURCE_ATTRIBUTES=lunasq.task_id=…,lunasq.run_id=…,lunasq.phase=…` (`telemetryRunEnv`). El Run sale del token, no del atributo: el atributo `lunasq.run_id` solo se contrasta. Un registro que declara otro Run se descarta, y con session id nativo también uno de otra sesión, igual que los hooks de subagentes (ADR uw-19-revisores). Un token ausente o desconocido responde `{}` con 200, porque el exportador reintenta lo que no es 2xx; un cuerpo que no es OTLP responde 400.
- **Límites del cuerpo.** El token se valida antes de leer el cuerpo. El cuerpo recibido tiene un tope de 8 MB (413) y el gzip descomprimido uno de 32 MB (400), así un POST sin token o una zip-bomb no agotan la memoria del proceso que despacha los agentes. Un valor de atributo con tipo inesperado se lee como ausente en vez de rechazar el lote, porque los exportadores OTLP no reintentan un 400.
- **Sin `request_id`.** Un `source_ref` NULL no deduplica en SQLite; si falta, se usa `<session.id>#<event.sequence>`.
- **Runs cerrados.** El token se busca con `RunRepository.byToken`, que incluye Runs cerrados: Claude Code vacía su buffer al salir y el último lote llega después de que la tool de salida cerró el Run.
- **Revisores por `agent_id`.** `usage_records.agent_id` (migración 0006, `ADD COLUMN` sin recrear tablas) guarda el subagente que hizo la llamada. El desglose por revisor une `usage_records` con `run_subagents` por `(run_id, agent_id)` (ADR uw-19-revisores) y se limita a `REVIEWER_NAMES`. La unión es de lectura, así que no importa si el hook `SubagentStart` llegó antes o después del log. Las llamadas de un `agent_id` desconocido (hook perdido) cuentan en el total y no en un revisor.
- **Task.usage.** `GET /api/tasks/:id/usage` devuelve, además de `total` y `byRun`, `byPhase`, `byAgent`, `byModel` y `byReviewer`. En `byPhase` el rework es la implementación de una iteración de verificación posterior a la primera (`runs.iteration > 0`). Los grupos sin registros no aparecen. El costo solo se suma cuando todos los registros del grupo lo traen (ADR uw-21-front-end).
- **Feature flag.** `telemetry` de `~/.lunasq/config.json` (ADR uw-28-instalador) gobierna todo el usage collector. Con `false`, los panes no reciben variables OTEL (ni las generales ni las por Run), `createApp` no monta `/v1/logs` ni `/v1/metrics` y Claude Code recibe 404. Sigue activo por defecto. Los UsageRecords ya guardados siguen visibles.
- **Prueba real.** `pnpm --filter @lunasq/server test:usage` abre `claude -p --output-format json` con el entorno de un pane y compara los tokens y el costo guardados con el `usage` y el `total_cost_usd` que Claude Code reporta. Pasó con Claude Code 2.1.314. Los tests normales usan un lote real saneado (`packages/server/src/usage/fixtures/`).

## Consecuencias

- **Fuera de alcance.** La conciliación contra el transcript al cerrar el Run y la tabla de precios versionada (`source = transcript | calculated`, `pricing_version`) quedan para cuando exista un agente que no reporte costo (Codex, v2). `costUsd` es el estimado del cliente de Claude Code, no la factura (`docs/design.md` §Limitaciones).
- **UW-21.** El panel de usage puede mostrar los desgloses nuevos; hoy solo usa `total` y `byRun`.
- **UW-23 y UW-24.** El consumo por revisor ya está disponible por si la verificación o la evidencia quieren citarlo.
- **UW-28.** `doctor` ya puede avisar si `telemetry` está apagado; el mensaje sigue siendo válido.
- Un Run cerrado acepta registros mientras conserve su token y sesión; solo puede inflar su propio Run. No se limita por ventana de tiempo.
- El endpoint no valida Host ni Origin: sin un token de Run válido no tiene efectos, y el token tiene 256 bits.
