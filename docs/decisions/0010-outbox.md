# 0010 — Outbox de eventos: encolado transaccional y publicador at-least-once

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-08 · Código: `packages/db/src/outbox.ts`, `packages/db/src/event-log.ts`, `packages/server/src/outbox/`, esquema en `packages/schemas/src/outbox.ts`

## Contexto

`docs/design.md` (§Componentes) pide publicar los cambios de estado hacia el scheduler y el dispatcher sin perder eventos entre la base y la cola. UW-01 dejó la tabla `outbox` (id autoincremental, `event_id` único, `topic`, `payload`, `published_at`, `attempts`) y ADR 0007 fijó que el outbox sale de los eventos `task.transitioned`. El criterio de UW-08 es que ningún evento se pierda ante una caída entre el commit y la publicación.

## Decisión

- **Encolado en la misma transacción.** `appendEvent(db, input, { publish: true })` escribe el evento y su fila de outbox en una transacción; dentro de otra (como en `transitionTask`) es un savepoint, así que se confirma o se revierte junto con quien llama. `transitionTask` siempre publica. Si el commit ocurre, la fila pendiente existe; si no, no existe ni el evento ni el cambio de estado. Otros eventos (p. ej. `task.created` de UW-07) eligen publicar con la misma opción.
- **Idempotente.** `enqueueOutbox` ignora un `event_id` ya encolado.
- **Topic = tipo del evento.** El mensaje (`OutboxMessage` en `@lunasq/schemas`) se arma con un join a `events`: `id`, `eventId`, `topic`, `taskId`, `actor`, `payload`, `createdAt`. La columna `outbox.payload` queda en `NULL` para no duplicar el payload del evento; cada suscriptor valida el payload con el esquema de su topic.
- **Publicador en proceso** (`OutboxPublisher`): suscriptores por topic o `*`. `drain()` lee pendientes en orden de `id`, entrega a cada suscriptor en orden de registro y esperando a los asíncronos, y marca `published_at`. Una sola pasada a la vez: un `drain` o `wake` durante otra pide una pasada más, y si llega cuando la pasada ya está saliendo, se relanza al terminar; así no se queda atrás lo confirmado después de la lectura. Tras un fallo de entrega no hay pasada extra: el reintento espera al siguiente `wake` o poll. `start()` hace un drain inicial (recupera lo que dejó una caída) y arranca un poll periódico (1 s por defecto); `wake()` lo adelanta después de un commit; `stop()` detiene el poll y espera al mensaje en curso.
- **At-least-once y en orden.** Si el proceso cae después de entregar y antes de marcar, el mensaje se entrega otra vez al arrancar. Si un suscriptor falla, se suma `attempts`, se avisa con `onError` y el drain se detiene para no entregar fuera de orden; el siguiente drain reintenta desde ese mensaje y lo reentrega también a los suscriptores que ya lo habían recibido.
- **Sin suscriptores.** Con al menos un suscriptor registrado, un mensaje cuyo topic no tiene destinatarios se marca publicado. Sin ningún suscriptor el drain no marca nada, así un `start` antes de registrarlos no pierde lo que dejó una caída.
- **Prueba del criterio.** Un proceso hijo confirma una transición y muere con `SIGKILL` antes de publicar; un publicador nuevo sobre el mismo archivo la entrega al arrancar. Otro hijo recibe el mensaje y muere dentro del handler, antes de marcarlo; el publicador siguiente lo reentrega. Los hijos corren con `--experimental-transform-types` porque `@lunasq/db` usa parameter properties, que el modo strip-only de Node no acepta.

## Consecuencias

- Los suscriptores (UW-13 scheduler, UW-16 dispatcher) deben ser idempotentes ante mensajes repetidos; el scheduler lo es porque recalcula el ready set desde la base.
- La unidad que componga el servidor (UW-13 al conectar el scheduler, o la que monte el proceso) crea un `OutboxPublisher`, registra suscriptores, llama `start()` y `wake()` después de cada transición confirmada; al apagar, `stop()`.
- Un suscriptor que falla siempre bloquea la cola (mensaje venenoso): no hay dead-letter en v1. `attempts` y `onError` lo hacen visible; si hace falta, se agrega un tope que escale a needs_human o marque el mensaje.
- Los reintentos no tienen backoff: un mensaje que siempre falla se reintenta en cada `wake` y cada poll, y llama `onError` cada vez.
- `stop()` espera sin límite al handler en curso; un handler que nunca resuelve bloquea el apagado. Los suscriptores no deben quedarse esperando I/O sin timeout.
- Las filas publicadas no se purgan; con el volumen de v1 no hace falta. `published_at` permite purgar después.
- Un publicador por base. Dos procesos publicando sobre el mismo archivo podrían entregar dos veces; v1 corre en un solo proceso.
