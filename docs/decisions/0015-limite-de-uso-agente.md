# ADR — Límite de uso del agente: detección por pantalla y needs_human

- Estado: aceptada
- Fecha: 2026-10-30
- Código: `packages/adapters/src/herdr/claude-tui.ts` (`showsUsageLimit`, `usageLimitMessage`), `packages/schemas/src/events.ts` (`EscalationReason.usage_limit`), `packages/schemas/src/notification.ts` (kind `usage_limit`), `packages/server/src/reconciler/watcher.ts` (`usageLimit`, `escalateUsageLimit`, `checkBlocked`)

## Contexto

Cuando Claude Code llega a su límite de uso, su TUI dibuja el aviso y el turno termina: herdr lo ve como `idle`/`done` (caja de prompt) o `blocked` si dibuja el menú de `/rate-limit-options` (su manifiesto de detección no tiene regla para ese UI). Hasta hoy LunasQ trataba esa parada como cualquier `idle/done`: nudges que reinician el agente para volver a chocar con el límite, y al agotarlos un Run fallido por `agent_stopped` que consume reintentos en la misma condición. Y `herdr agent read` ya existe: fue la vía para reconocer el diálogo de confianza (ADR 0004 y uw-16).

Formas vistas del aviso (claude.ai docs del CLI, octubre de 2026):

- `Usage limit reached · limit resets 3:45pm` con pie `Continuing automatically at 3:45pm · Esc to cancel` (auto-continue, v2.1.234+).
- `Usage limit reached · wrapping up`; mensajes viejos `5-hour limit reached · resets <hora>` y `You've reached your weekly limit. It resets <día> a la hora`.
- `Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again`.

## Decisión

- **El texto de Claude se reconoce en `adapters`** (`showsUsageLimit`, `usageLimitMessage` al lado del diálogo de confianza), y la lectura de pantalla vive en el watcher: en la vía de agente detenido (`idle`/`done` pastada la gracia) y en la vía `blocked` (entró un bloqueo que puede ser el menú del límite, no un permiso; se lee antes de que madure el aviso de agente bloqueado del minuto).
- **No es un fallo de Run:** es una pausa humana. El watcher aplica `escalate` con la razón nueva `usage_limit` y `expected` en `running`, con el texto que dibujó Claude como nota, y notifica de inmediato (id `usage:<runId>` y kind `usage_limit`, como el timeout de fase: el `escalationNotification` del outbox no lo repite). El Run y el agente quedan como están — si la espera automática de Claude sigue, el humano decide en herdr.
- El `resume` de siempre saca de `needs_human`: cierra el Run viejo y re-despacha la fase con el mismo worktree (mecánica del timeout). Igual que el timeout, el reloj queda detenido: sin nudges ni timeout mientras la tarea espera.
- Falsos positivos aceptados y acotados: el patrón exige frases del CLI (`usage limit reached`, `usage-limit`, `limit resets <hora>`, etc.) y solo se lee la pantalla en parada de fase; si el propio trabajo del agente menciona límites con esas formas exactas, el escalamiento es recuperable en un click (resume) y la notificación muestra el texto que lo disparó.

## Consecuencias

- Cuando Claude termina el turno por límite, LunasQ no quema nudges ni reintentos: la tarea queda en `needs_human` con el estado de análisis en pantalla.
- La detección depende de la TUI: si Claude cambian sus textos, hay que actualizar `USAGE_LIMIT_PATTERN` en adapters; los spikes de `herdr agent read` son la vía para capturarlos.
- Prueba contra herdr/Claude reales pendiente para el piloto (complementa los pendientes de reloj y nudges en [uw-17](uw-17-reconciliacion.md)).
