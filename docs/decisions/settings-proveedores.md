# ADR — Settings: habilitar y deshabilitar proveedores de agente

- Estado: aceptada
- Fecha: 2026-11-01
- Código: `packages/schemas/src/settings.ts` (`AgentProviderSettings`, `settings.updated`), `packages/db/src/settings.ts` y migración `0010_settings_proveedores`, `packages/domain/src/providers.ts` (`effectiveAgentKind`, `enabledFallbackOrder`), `packages/domain/src/scheduler.ts` (`schedule`, `Occupancy`), `packages/db/src/runs.ts` (`claimRun`), `packages/server/src/dispatcher/dispatcher.ts` (`startAgentWithFallback`), `packages/server/src/api/settings.ts`, `packages/web/src/pages/settings.tsx`

## Contexto

Cuando se agota el límite de uso de Claude Code o de Copilot CLI, el scheduler seguía despachando tareas a ese proveedor: cada una arrancaba, chocaba con el límite y consumía un ciclo de Run y de reintentos sin necesidad. El humano necesita apagar un proveedor a mano, sin tocar la configuración de cada proyecto.

## Decisión

- **Configuración global.** `AgentProviderSettings` es un booleano `enabled` por cada `AgentKind` (default todos `true`). Se guarda en la tabla `app_settings` (clave `providers`, valor JSON validado con Zod al leer y escribir). Sin fila guardada, todos están habilitados. Guardar es un upsert: repetir la misma configuración deja el mismo estado.
- **Proveedor efectivo.** El primario es el `kind` del perfil de la fase. El orden de fallback es el primario y luego los demás `AgentKind` en orden de registro, filtrado por habilitados; el efectivo es el primero de esa lista, o ninguno. `domain` expone `effectiveAgentKind` y `enabledFallbackOrder` y no conoce la base: `schedule`, `Occupancy` y el claim reciben los proveedores habilitados como dato.
- **Scheduler.** Lee la configuración en cada pasada. El slot y el `agentKind` de cada decisión usan el proveedor efectivo, así el límite por tipo de agente se aplica al proveedor que de verdad correrá. Con todos deshabilitados el plan no tiene decisiones de despacho: las tareas siguen en `queued` (no se pausan con un estado nuevo, simplemente no se despachan). Los agentes vivos cuentan contra el proveedor con el que corren de verdad (`SchedulerTask.agentKind`, el `agentKind` de su Run abierto, que puede ser un fallback); si falta, contra el primario de su perfil.
- **Claim.** `claimRun` vuelve a leer la configuración dentro de su transacción (el humano pudo cambiarla después de planear). Sin proveedor efectivo rechaza con `providers_disabled`, sin tocar la tarea ni crear un Run. El Run se crea con el proveedor efectivo, y el modelo del perfil solo se aplica si es el primario.
- **Lanzamiento.** `startAgentWithFallback` lee los proveedores habilitados justo antes de arrancar cada uno, otra vez después de preparar el pane (esa preparación espera a herdr y al disco): un proveedor deshabilitado no se intenta ni deja registro de intento, y el pane ya preparado se cierra. Si no queda ninguno, el Run falla con el diagnóstico `todos los proveedores están deshabilitados en Settings` y la tarea pasa a `needs_human` por la vía de `providers_unavailable`.
- **Agentes vivos intactos.** Cambiar la configuración nunca interrumpe ni cierra un Run en curso; solo afecta a despachos y lanzamientos nuevos.
- **API y evento.** `GET` y `PUT /api/settings/providers`. El PUT acepta un cambio parcial (solo los kinds que trae) que se aplica sobre lo vigente dentro de la transacción: cada interruptor de la UI envía solo su proveedor, así dos pestañas con vistas viejas no se pisan (400 `invalid_input` si el cuerpo trae un kind desconocido o un valor no booleano; no cambia lo guardado). Guardar registra `settings.updated` en el Event log y el outbox en la misma transacción; el scheduler, suscrito a todos los topics, corre una pasada y despacha con el proveedor habilitado.
- **`events.task_id` pasa a ser nullable** (y `OutboxMessage.taskId` también): `settings.updated` es un evento global sin tarea. Los consumidores del outbox que operan sobre una tarea ignoran los mensajes con `taskId` nulo, y `changesSince` no los cuenta como cambio de tarea. La migración reconstruye `events`, recrea los triggers append-only y respalda y restaura `outbox`: Drizzle migra dentro de una transacción, donde `PRAGMA foreign_keys=OFF` no tiene efecto, y el `DROP TABLE events` borraría en cascada las filas del outbox.
- **UI.** Página `/settings` con un interruptor por proveedor (enlazada en la navegación) (el apagado con contraste suficiente; tras guardar vuelve a leer la configuración en vez de pisar la caché con la respuesta del PUT) y un aviso global de «Despacho en pausa» con enlace a Settings cuando ambos están deshabilitados.

## Consecuencias

- Deshabilitar solo un proveedor aplica las reglas de fallback de [ADR 0016](0016-proveedores-agente.md); deshabilitar ambos equivale a pausar el despacho sin perder la cola.
- Una tarea cuyo perfil usa un proveedor deshabilitado corre con el otro: los flags de perfil (`args`) del primario no se trasladan, como en cualquier fallback. La verificación con revisores sigue siendo Claude-only (ADR 0016), así que una verificación despachada a Copilot por un deshabilitado hereda esa limitación.
- Añadir un `AgentKind` nuevo lo hace aparecer en la configuración con default habilitado y en la página Settings sin cambios de esquema.
- No hay habilitado automático al renovarse el límite de uso: el humano reactiva el proveedor desde Settings.

## Origen de las peticiones

`/api/settings/*` no tiene autenticación y muta estado que pausa el despacho, así que rechaza con 403 `forbidden_origin` cualquier `Host` u `Origin` que no sea `localhost`, `127.0.0.1` o `[::1]` (defensa contra DNS rebinding, igual que el MCP).
