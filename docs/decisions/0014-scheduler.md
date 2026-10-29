# 0014 — Scheduler: ready set, score y límites

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-13 · Código: `packages/schemas/src/scheduler.ts`, `packages/domain/src/scheduler.ts`, `packages/db/src/scheduler-state.ts`, `packages/server/src/scheduler/`

## Contexto

`docs/design.md` (§Scheduler) define el ready set, el score (prioridad base + aging + boost), la herencia de prioridad y cuatro niveles de límites (global con default 5, proyecto, tipo de agente y fase), sin preemption. No decía qué cuenta como slot ocupado, qué mide el límite por proyecto, desde cuándo corre el aging ni dónde viven los límites globales. ADR 0010 dejó a UW-13 decidir qué hacer con los dependientes de una tarea cancelada.

## Decisión

- **Reglas en el dominio.** `schedule(snapshot, projects, config, now)` es puro y devuelve `{ dispatch, escalate }`. `rankReady` calcula el ready set ordenado y `pendingPhase` mapea estado a fase: draft → refine, in\_progress → implement, verification → verify. La entrega corre dentro del Run del verificador (ADR 0007), así que no se agenda aparte.
- **Ready set.** Entran las tareas con sub‑estado `queued` en un estado con agente cuyas dependencias tienen todas `prState = merged`. Una dependencia ausente del snapshot no satisface.
- **Score.** `prioridad efectiva + agingPointsPerHour × horas en ready + boostPerDescendant × descendientes vivos`. La prioridad efectiva es el máximo entre la prioridad base y la de los descendientes vivos (herencia transitiva); deja de heredar cuando la bloqueada llega a un estado terminal. Desempate: antigüedad (`createdAt`) y luego id. Defaults: 10 puntos por hora y 25 por descendiente, en las unidades de la prioridad.
- **readySince.** Lo calcula la base: lo más reciente entre la creación de la tarea, su último `task.transitioned` y el `updatedAt` de sus dependencias. Así el aging sobrevive a un reinicio. Editar la prioridad (`task.updated`) no lo reinicia. Mientras UW-14 no registre la hora del merge, el `updatedAt` de la dependencia la aproxima.
- **Slots.** Ocupa un slot toda tarea en un estado con agente con sub‑estado `running` o `waiting_human`: con una pregunta abierta el agente puede seguir vivo (`answer` vuelve a running). Los gates humanos (refined) y needs\_human no ocupan.
- **Límites.** Global (`globalConcurrency`, default 5), por fase (`phaseConcurrency`) y por tipo de agente (`agentKindConcurrency`) viven en `SchedulerConfig` (`@lunasq/schemas`), que el proceso recibe al arrancar. El límite por proyecto es `ProjectLimits.concurrency` (ADR 0008) y cuenta los **agentes vivos del proyecto en todas las fases**, no solo los de in\_progress: es lo que acota la carga y los conflictos, y garantiza el tope en cualquier mezcla de fases. El tipo de agente sale de `phaseProfile` del proyecto. Una tarea cuyo proyecto no tiene configuración no se despacha.
- **Sin preemption.** El plan recorre el ready set por score y toma cada tarea que cabe en los cuatro niveles; una que no cabe se salta y sigue la siguiente. Los agentes vivos nunca se interrumpen.
- **Dependencias que no se entregarán.** Si una dependencia tiene el PR cerrado sin merge o está cancelada sin PR mergeado, el scheduler escala a los dependientes directos que no son terminales ni están en needs\_human, con `escalate` y `reason: dependency_pr_closed` (se reutiliza la razón para la cancelación), con `expected` para no pisar un cambio concurrente. Sale de needs\_human cuando el humano quita la arista y reanuda; si la reanuda sin quitarla, se escala otra vez.
- **Snapshot.** `SchedulerStateReader.snapshot()` (puerto en el dominio, `SchedulerStateRepository` en db, `InMemorySchedulerStateReader` en tests, contrato compartido) devuelve las tareas vivas, las terminales de las que alguna viva depende y las aristas de las vivas, leídas en una transacción.
- **Proceso.** `Scheduler` (server) corre una pasada con `run()`. Las pasadas no se solapan: un pedido durante una pasada se agrupa en una pasada más, como en el publicador del outbox. Se suscribe a `*` en el `OutboxPublisher` (el handler solo pide la pasada, no la espera) y tiene un tick (`tickIntervalMs`, default 30 s) que recoge el aging y los cambios que no pasan por el outbox. Después de escalar despierta al publicador. `stop()` corta el tick y la suscripción y espera la pasada en curso, que no despacha más decisiones.
- **Puerto `Dispatcher`.** `dispatch(decision)` resuelve cuando el claim quedó confirmado (la tarea está en running) o rechaza. El scheduler espera cada despacho antes del siguiente, así la pasada siguiente ve los slots ocupados. Un rechazo se reporta con `onError` y no detiene la pasada.

## Consecuencias

- **UW-16** implementa `Dispatcher`. Dentro del claim debe volver a validar `expected` (con `transitionTask` y `dispatch`) y los límites: el plan se calculó antes y otro proceso (la CLI) podría haber despachado en medio. También compone el proceso: crea el `Scheduler` con el publicador y llama `start()` y `stop()`.
- **UW-14** registra el merge en la tarea (`prState`, y con eso su `updatedAt`); si agrega un evento con la hora del merge, `readySince` puede usarlo en vez del `updatedAt`.
- **UW-17** no debe tratar como caída una tarea en `waiting_human`: ocupa slot a propósito.
- **Límites globales.** Se configuran al arrancar el proceso; no hay API ni tabla para cambiarlos en caliente en v1.
- **Costo por pasada.** Cada pasada lee todas las tareas vivas y sus aristas, y el ranking recorre los descendientes de cada candidata. Con el volumen de v1 basta; si crece, se cachea el grafo por pasada o se calcula el conteo de descendientes una sola vez.
