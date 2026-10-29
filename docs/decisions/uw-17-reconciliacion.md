# UW-17 — Señales, nudges, timeout de fase, backoff y reconciliación

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-17 · Código: `packages/server/src/reconciler/` (`RunWatcher`, `PhaseClock`, `Reconciler`, `escalationNotification`), `packages/server/src/dispatcher/orchestrator.ts`, `packages/domain/src/scheduler.ts` (`retryAt`), `packages/domain/src/dispatch.ts` (`nudgePrompt`, `isAgentName`), `packages/db/src/scheduler-state.ts` (`retry`), `packages/db/src/task-worktrees.ts` (`releasable`), `packages/schemas/src/{scheduler,notification}.ts`

## Contexto

`docs/design.md` (§Señales y cómo se interpretan, §Timeout de fase, §Loop de reconciliación) fija la tabla de señales, el timeout de 30 minutos con pausa, los 3 reintentos con backoff y la reconciliación con `session.snapshot`. Varios ADR le dejaron trabajo a esta unidad:

- ADR uw-16-dispatcher: implementar `RunObserver` y usar `failRun` ante un crash.
- ADR 0009: llamar `Escalator.watch`/`resolve` en `blocked`, con un id distinto por cada bloqueo.
- ADR 0010: detener el agente de una tarea cancelada.
- ADR 0012 y ADR uw-14-adapter-github: remover el worktree tras la cancelación o el merge, y limpiar los huérfanos.
- ADR 0014: no tratar `waiting_human` como caída.
- ADR 0007: no tratar como Run caído el intervalo de la entrega.

El criterio de UW-17: cada escenario de fallo simulado termina en el estado y la notificación esperados.

## Decisión

- **`RunWatcher`** implementa `RunObserver`. Por cada Run lanzado abre una suscripción de herdr a su pane, como pide ADR 0004, y comparte una suscripción global de ciclo de vida. Las señales de un Run se serializan con un `KeyedLock`, y antes de actuar cada una relee el Run y la tarea en la base. Así, una señal que llega después de que una tool del MCP cerró el Run no hace nada.
  - **`blocked`**: pausa el reloj y llama `Escalator.watch` con id `blocked:<runId>:<n>`. Al salir de `blocked`, llama `resolve` y reanuda el reloj.
  - **`idle`/`done` con el Run abierto y la tarea en `running`**: tras una gracia (`nudgeGraceMs`, 15 s por defecto), manda un nudge con `nudgePrompt`, hasta `maxNudges` veces (2 por defecto). Si el agente se detiene otra vez, `failRun` con `agent_stopped: …`. La gracia cubre la tool de salida que cierra el Run justo antes de que el agente termine su turno. En `waiting_human` no hay nudges.
  - **`pane_closed`/`pane_exited`** de un pane observado: `failRun` con `agent_exited: …`. El dispatcher llama `unwatch` antes de cerrar un pane propio, así que su propia limpieza no cuenta como crash. Con la tarea en `waiting_human` el Run queda abierto (ADR 0014): la respuesta relanza (UW-22). Un `subscription_failed` solo cuenta como pane perdido con `pane_not_found`; otro código pide reconciliar.
  - **Runs que no se fallan ni escalan:** un Run cerrado, o uno con handoff guardado (el verificador dio pass y la entrega corre con el Run abierto, ADR 0007). Sin nudges, sin `failRun` y sin timeout. Tras cada await el watcher confirma que el Run sigue observado, porque el dispatcher pudo llamar `unwatch` entretanto.
  - **Timeout vencido** (si vence con la pregunta abierta antes de que el outbox pausara el reloj, queda en pausa sin presupuesto y escala al responder): aplica `escalate` con `reason: phase_timeout` y `expected` en running, y notifica `phase_timeout` de inmediato (id `timeout:<runId>`). El agente sigue vivo y el Run queda abierto; desde ese momento solo se vigila que el pane siga vivo.
  - **Pérdida de eventos**: un `events_lost` en cualquier suscripción pide una pasada de reconciliación. Cuando la suscripción de un pane se reconecta (`subscribed`), se relee el estado del agente.
- **`PhaseClock`**: presupuesto de `phaseTimeoutMs(project, phase)`, que solo corre sin razones de pausa (`blocked`, `waiting_human`). La pausa por `waiting_human` llega por el outbox: `RunWatcher.onTransition` alinea el reloj con el sub‑estado de la tarea. **Vive en memoria**: tras un reinicio, el reconciliador vuelve a observar el Run con el presupuesto completo. Nunca escala antes de tiempo, pero puede tardar hasta un timeout más. Se descartó persistir el tiempo pausado porque requiere columnas nuevas y escrituras en cada cambio de estado.
- **Backoff de reintentos.** Lo decide el dominio: `retryAt(retry, config)` = fin del último fallo + `retryBackoffMs·2^(n‑1)`, con tope `maxRetryBackoffMs`. Los defaults son 30 s y 10 min (`SchedulerConfig`). `SchedulerStateRepository` agrega a cada tarea en `queued` su `retry`: los fallos seguidos de la fase pendiente, con el mismo `consecutiveFailures` de ADR 0007 (desde el último Run exitoso o `resume`), y el `endedAt` del último. `rankReady` no considera lista una tarea antes de `retryAt`, así que no ocupa slot. El tick del scheduler (30 s) la recoge al vencer. Aplica igual a los crashes que a `report_failure`. Los 3 reintentos siguen siendo los de `run_failed` (ADR 0007): el cuarto fallo seguido la manda a needs_human.
- **`Reconciler`**: corre cada `intervalMs` (60 s por defecto), al arrancar y cuando el watcher pierde eventos. Las pasadas no se solapan y un pedido durante una pasada se agrupa en otra, como en el scheduler. Lee el snapshot de herdr *antes* que `runs.active()`: así todo agente del snapshot pertenece a un Run ya visible. Cada Run se relee antes de corregirlo, porque las correcciones anteriores de la pasada esperan a herdr. Por Run abierto:
  - Si el Run tiene **handoff guardado**, no se toca: es el pass del verificador mientras corre la entrega (ADR 0007).
  - **Tarea en needs_human**: se respeta y, si el agente vive, se vuelve a observar.
  - **Tarea fuera de la fase del Run** (cancelada, reanudada tras un timeout, en otro estado): `closeRun` con `result: cancelled` y `failureReason: task_left_phase: …`, que también cierra el pane. Aplica también a un Run reclamado sin lanzar: su lanzamiento se detiene en el siguiente paso (`RunClosed`).
  - **Agente vivo sin observar**: `watch`.
  - **Sin agente con la tarea en running** (confirmado con `getAgent`, por si el snapshot se tomó antes de que arrancara): `failRun` con `agent_lost: …`. En `waiting_human` no se falla, porque la respuesta relanza (UW-22).
  - Después llama a `dispatcher.recover()`, que ahora salta los Runs con un lanzamiento en curso. Va después del cierre de los Runs fuera de fase, así esos no se relanzan.
  - Si la pasada cerró o falló algún Run, despierta al scheduler (`onRunsClosed`): una tarea reanudada tras un timeout se redespacha sin esperar al tick.
  - **Panes huérfanos**: se cierra el de cualquier agente con nombre de LunasQ (`isAgentName`) sin Run abierto; los agentes ajenos no se tocan.
  - **Worktrees**: se remueve (sin forzar) el de cada tarea en `TaskWorktreeRepository.releasable()`, que usa la misma regla que `worktreeReleased`: cancelada, o completada con el PR mergeado. Un fallo, por ejemplo `dirty_worktree`, se reporta una sola vez. Una tarea con un Run todavía abierto espera a otra pasada. Cada `orphanWorktreesEvery` pasadas (10 por defecto) se llama `cleanupOrphans` en cada proyecto, porque esa búsqueda lista el repo en herdr y puede crear el workspace del proyecto (ADR 0012).
  - Una cancelación o un `resume` (outbox `task.transitioned`), o un merge (`task.pr_state_changed` con `to: merged`), piden una pasada inmediata.
- **Reanudar tras un timeout.** Las tools de salida exigen `running` (ADR 0007), así que "esperar" significa dejar la tarea en needs_human mientras se mira el agente en herdr; ese agente ya no puede cerrar la fase. Al reanudar, la tarea vuelve a `queued` y el reconciliador cierra el Run viejo como cancelled. El scheduler redespacha la fase sobre el mismo worktree, con el código intacto.
- **Notificaciones de escalamiento por el outbox.** `escalationNotification` convierte una transición a needs_human en aviso:
  - `retries_exhausted` produce el kind nuevo `retries_exhausted`, con id `retries:<taskId>:<eventId>`;
  - `iterations_exhausted` produce `verification_exhausted`, con id `iterations:<taskId>:<eventId>`.

  Así hay un solo lugar que avisa, venga el escalamiento del dispatcher o del LunasQ MCP. El id sale del evento, de modo que la entrega "al menos una vez" del outbox no duplica avisos (ADR 0009). El timeout de fase lo notifica el watcher directamente.
- **Composición.** `Orchestrator` arma `RunWatcher` (el observador del dispatcher, salvo que se pase `observer`), `Reconciler` y las suscripciones al outbox. Si no recibe `notifications`, arma el módulo con herdr como canal y lo expone en `orchestrator.notifications`, para que quien componga el servidor monte el SSE. `start()` reconcilia antes de arrancar el scheduler. `stop()` detiene la reconciliación y el scheduler, espera los lanzamientos y deja de observar.

## Consecuencias

- **Concurrencia en needs_human por timeout.** El agente sigue vivo pero la tarea no ocupa slot (`Occupancy` cuenta solo `running` y `waiting_human`, ADR 0014). Mientras el humano decide, se puede pasar temporalmente del límite de concurrencia. Se acepta en v1; si molesta, `Occupancy` puede contar los Runs abiertos.
- **UW-22** responde las preguntas. Si el agente murió en `waiting_human`, ni el watcher ni el reconciliador lo fallan: el Run queda abierto hasta que `answer` lo mueva: con `agentAlive: false` la tarea pasa a `queued` y el reconciliador cierra el Run viejo como cancelled.
- **UW-26** no necesita remover el worktree tras el merge: lo hace la reconciliación. Si la entrega cae con el Run del verificador abierto y con handoff, el reconciliador no lo toca; UW-26 debe cerrarlo o reintentarlo.
- **UW-23** no tiene que emitir `verification_exhausted`: llega por el outbox.
- **Nudges y bloqueos en memoria.** Tras un reinicio el contador de nudges vuelve a 0, y un `blocked` previo se vuelve a escalar a 1 minuto desde el reinicio (con un id que puede repetir el anterior; la deduplicación en memoria de ADR 0009 también se reinició).
- **Sin probar contra herdr real en esta unidad:** que Claude Code reporte `done`/`idle` al terminar el turno y no entre herramientas. Si reporta `idle` entre herramientas, la gracia de 15 s evita nudges espurios; el piloto (UW-29) lo calibra.
