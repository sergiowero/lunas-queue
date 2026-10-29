# 0007 — Notificaciones: id determinístico, deduplicación en memoria y dos canales

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-06 · Código: `packages/server/src/notifications/`, esquema en `packages/schemas/src/notification.ts`

## Contexto

`docs/design.md` (Señales, Human‑in‑the‑loop y Decisiones) pide avisar al humano por herdr y por la UI en cuatro casos: Question abierta y agente `blocked` (si siguen así después de 1 minuto), y timeout de fase y loop de verificación agotado (de inmediato). El criterio de UW-06 es que una notificación llegue por ambos canales sin duplicarse. No hay tabla de notificaciones (UW-01) y el Event log (UW-04) aún no existe. ADR 0004 dejó pendiente qué hacer con `[ui.toast] delivery = "off"`, el default de herdr.

## Decisión

- **`Notification`** en `@lunasq/schemas`: `id`, `kind` (`question_open | agent_blocked | phase_timeout | verification_exhausted`), `taskId`, `runId?`, `title`, `body`, `createdAt`. El `id` lo arma quien la emite a partir de la situación (p. ej. `question:<questionId>`, `blocked:<runId>:<n>`) y es la clave de deduplicación en todos los canales.
- **`NotificationService.notify`** valida, descarta un `id` ya entregado y reparte a cada canal en paralelo. El `id` se marca antes de esperar a los canales, así dos llamadas concurrentes entregan una sola vez. Un canal que falla se reporta con `onChannelError` y no impide a los demás. Si al menos un canal entregó, el id queda como entregado y el canal que falló no se reintenta. Si ninguno entregó, se libera el id y un aviso posterior con el mismo id reintenta.
- **Canales:** `herdrChannel` (`notification show` con `sound: request`) y `hubChannel` (hub en memoria hacia la UI).
- **SSE** en `GET /stream` (montado bajo `/api/notifications` cuando el servidor se componga): cada notificación es un `event: notification` con `id:` igual al de la notificación. El hub guarda las últimas 100. Una reconexión con `Last-Event-ID` recibe solo lo posterior. Si ese id ya salió del buffer, recibe el buffer completo, que es todo posterior.
- **`Escalator`**: `watch(pending, { since? })` notifica a los 60 s desde `since` (por defecto, ahora) y `resolve(id)` lo cancela. Repetir `watch` con un id vigilado no reinicia el plazo, y con un id ya escalado no hace nada hasta `resolve`. `escalated()` lista lo escalado sin resolver. `since` permite re‑armar desde la BD tras un reinicio (p. ej. con el `createdAt` de la Question). El timeout de fase y el loop agotado llaman `notify` directo.
- **Deduplicación en memoria.** Tras un reinicio del proceso una notificación puede repetirse una vez. Se acepta en v1: es una molestia menor y no afecta el estado de ninguna tarea.
- **Toast apagado.** Si herdr responde `shown: false`, el canal herdr lo reporta como error de canal (con el `reason`) y la UI la recibe igual. `lunasq install` no cambia la configuración de herdr; `lunasq doctor` (UW-28) avisa si `ui.toast.delivery` está en `off`.

## Consecuencias

- UW-17 llama `watch` al ver `blocked` y `resolve` al salir de ese estado; al reconciliar, re‑arma con `since` lo que siga pendiente en la BD. Para un segundo `blocked` del mismo Run usa otro `id` (el contador `<n>`), o la deduplicación lo silencia.
- UW-22 hace lo mismo con cada Question abierta y llama `resolve` al responderla.
- UW-21/UW-27 consumen el stream SSE y pueden deduplicar por `id` si lo necesitan; el servidor ya no reenvía lo visto.
- Si se necesita que la deduplicación sobreviva reinicios, se registra cada notificación en el Event log (UW-04) y el servicio consulta ahí antes de entregar.
- El stream SSE no manda keepalive ni acota las escrituras pendientes de un cliente lento; con el volumen de v1 en `localhost` no hace falta. Si UW-21/UW-27 lo necesitan, se agrega un comentario `:` cada ~30 s.
- La liberación de la suscripción al desconectarse el cliente solo se prueba con `app.request`. La unidad que monte `/api/notifications` sobre `@hono/node-server` agrega un test con un servidor HTTP real que desconecte al cliente.
- El set de ids entregados crece con cada notificación del proceso; con el volumen de v1 (decenas al día) no se acota.
