# UW-22 — Preguntas del agente y bloqueos por permiso

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-22 · Código: `packages/server/src/questions/` (`QuestionService`, `QuestionEscalations`), `packages/server/src/api/questions.ts`, `packages/db/src/questions.ts` (`QuestionRepository`), `packages/schemas/src/question.ts`, `packages/domain/src/dispatch.ts` (`answerPrompt`), `RunWatcher.blocked()`

## Contexto

`docs/design.md` (§Preguntas del agente y bloqueos) fija el flujo de `ask_human`: la Question se guarda, la tarea pasa a `waiting_human` y el timeout se pausa; el humano responde en la bandeja; la respuesta llega al pane vivo con `agent prompt` o, si el agente ya no está, a un Run nuevo por `get_task_context`. ADR uw-15-mcp-tools dejó a esta unidad la respuesta; ADR uw-17-reconciliacion dejó abierto el Run de una tarea en `waiting_human` y ADR 0009 el aviso a 1 minuto.

## Decisión

- **Una pregunta abierta por tarea.** `ask_human` ya rechaza una segunda con la tarea en `waiting_human`, así que `QuestionRepository.openForTask` devuelve a lo sumo una.
- **Responder es una transacción.** `QuestionRepository.answer` aplica `answer` (actor `human`, `waiting_human` → `running` o `queued`), marca la Question como `answered` con `answeredBy`/`answeredAt` y agrega el evento `question.answered` (`delivery: pane | new_run`). Una pregunta que ya no está abierta responde `not_open`; una tarea que dejó `waiting_human`, `task_not_waiting`. Nada se escribe en un rechazo. `answeredBy` es `human` si el cliente no lo manda: v1 es un solo usuario.
- **Entrega, en este orden** (`QuestionService.answer`, un candado por pregunta):
  1. Se comprueba que el Run que preguntó sigue abierto y que `getAgent(herdrName)` devuelve el mismo `paneId` que el Run guardó. Un agente con el mismo nombre en otro pane no recibe la respuesta.
  2. Se manda `answerPrompt` con `promptAgent`: pregunta y respuesta en una sola línea, con la skill de la fase para que cierre con su tool de salida. Si herdr falla, el agente se da por perdido.
  3. Se confirma la transacción con `agentAlive` según el paso anterior. El prompt va antes que la transición: si herdr lo rechaza, la respuesta no se pierde y sigue por el Run nuevo. La ventana entre el prompt y `running` son milisegundos, mucho menos que lo que tarda el agente en llamar una tool de salida.
  4. Sin agente vivo, `dispatcher.closeRun(..., cancelled, "question_answered: …")` cierra el Run viejo y su pane de inmediato y despierta al scheduler. Así el claim del Run nuevo no choca con `run_active` y no espera al reconciliador, que cerraría igual el Run de una tarea fuera de su fase (ADR uw-17-reconciliacion).
  - El Run nuevo recibe la Question con su respuesta en `get_task_context` (`questions`), sin cambios en el MCP.
- **Aviso a 1 minuto** (`QuestionEscalations`). Al ver en el outbox la transición a `waiting_human`, arma `Escalator.watch` con id `question:<questionId>`, kind `question_open` y `since` igual a la creación de la Question. Responder, cancelar la tarea o salir de `waiting_human` llaman `resolve`. Al arrancar, `rearm` vuelve a armar el plazo de cada pregunta abierta desde la base (el reloj vive en memoria, ADR 0009) y cancela las que ya no corresponden a una tarea en `waiting_human`.
- **Cancelación.** Si la tarea sale de `waiting_human` sin respuesta (cancelación, needs_human), sus preguntas abiertas pasan a `cancelled` con el evento `question.cancelled` y la causa (`task_cancelled` o `left_waiting_human`).
- **Timeout de fase.** Sin cambios respecto a ADR uw-17-reconciliacion: el `PhaseClock` se pausa en `waiting_human` y se reanuda al responder, así que una respuesta horas después no vence la fase. UW-22 lo cubre con tests de extremo a extremo.
- **API.** `GET /api/questions` (filtros `status`, `taskId`, `projectId`; las más viejas primero), `GET /api/questions/:id` y `POST /api/questions/:id/answer` (`{ answer, answeredBy? }` → `{ question, delivery }`; 404, 409 para `not_open` y `task_not_waiting`, 503 sin servicio). `createApp` recibe `questions` (el `QuestionService` del orquestador); quien compone el servidor lo conecta.
- **Eventos a la UI.** La pregunta aparece de inmediato en la bandeja por la consulta (`GET /api/questions?status=open`), que la UI refresca con las transiciones; el SSE de notificaciones (ADR 0009) lleva el aviso `question_open` a 1 minuto. No hay un stream aparte de preguntas.
- **Bloqueos por permiso.** El aviso a 1 minuto y la pausa del timeout ya los hace el `RunWatcher` (ADR uw-17-reconciliacion). Esta unidad agrega `RunWatcher.blocked()` y `GET /api/blocked` (`createApp({ blocked })`), que listan los agentes bloqueados con su pane. Se responden en herdr: LunasQ no contesta permisos.

## Consecuencias

- El adapter de herdr no tiene `agent focus`; UW-27 decide cómo la bandeja lleva al pane (con el `paneId` de `/api/blocked`) y si se agrega al adapter.
- Una respuesta duplicada del outbox o un doble clic no reenvía el prompt: el candado por pregunta y `not_open` lo evitan.
- Si el proceso cae entre el prompt y la confirmación de la transacción, la pregunta sigue abierta y el humano puede responder otra vez; el agente recibiría dos respuestas. Se acepta en v1.
- Sin probar contra el Claude Code real: que la TUI acepte un prompt de una línea mientras está `idle` tras terminar el turno de `ask_human`. Es el mismo mecanismo del nudge; el piloto (UW-29) lo calibra.
- UW-21 y UW-27 consumen estos endpoints y el SSE de notificaciones.
