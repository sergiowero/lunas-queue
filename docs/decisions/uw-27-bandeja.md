# UW-27 — Bandeja de aprobaciones, preguntas y bloqueos

- Estado: aceptada
- Fecha: 2026-10-30
- Unidad: UW-27 · Código: `packages/web/src/pages/inbox.tsx`, `packages/web/src/lib/inbox.ts`, `packages/web/src/components/task/spec.tsx`, `packages/server/src/api/questions.ts` (`blockedRoutes`), `packages/server/src/runtime/runtime.ts`, `HerdrAdapter.focusAgent`

## Contexto

El criterio de UW-27 es que todo lo que espera al humano aparezca y se resuelva desde la bandeja. `docs/design.md` (§Aprobación de la spec, §Preguntas del agente y bloqueos, §Front end: vistas mínimas) pide tres cosas: specs por aprobar con su diff (aprobar, pedir cambios o editar y aprobar), Questions abiertas que se responden en el front end, y agentes bloqueados por permiso con un acceso que enfoca su pane en herdr. ADR uw-22-preguntas dejó a esta unidad decidir cómo la bandeja lleva al pane y si se agrega `agent focus` al adapter; ADR uw-21-front-end dejó editar y aprobar y la decisión de montar el stream de notificaciones.

## Decisión

- **Una página, `/inbox`, con tres secciones**: «Specs por aprobar», «Preguntas abiertas» y «Agentes bloqueados». Cada pendiente es un `article` con el intent de la tarea (enlace al detalle) y su proyecto. El menú muestra «Bandeja» con el total de pendientes.
- **Specs por aprobar = tareas en `refined`.** Se derivan de `GET /api/tasks`, sin ruta nueva: en `refined` la última versión siempre está pendiente, porque aprobar o pedir cambios saca a la tarea de ese estado. Cada una monta `SpecVersions`, el mismo componente del detalle de tarea (versiones, contenido, diff contra la anterior y gate), así ambos lugares no divergen.
- **Editar y aprobar** (`POST /api/tasks/:id/specs/:version/edit-and-approve`, UW-12) se suma al gate, en la bandeja y en el detalle. El contenido se edita como JSON con formato. El cliente solo comprueba que parsea; `SpecContent` lo valida el servidor y la UI muestra sus issues (`ruta: mensaje`). Validar en el cliente metería zod en el bundle (ADR uw-21-front-end). Un editor por campos queda fuera de v1.
- **Preguntas**: `GET /api/questions?status=open` y `POST /api/questions/:id/answer` (UW-22). Tras responder se muestra a dónde fue la respuesta: al pane vivo o a un agente nuevo (`delivery`). Los 409 (`not_open`, `task_not_waiting`) se muestran tal cual.
- **Acceso al pane de un bloqueo**:
  - Se agrega `focusAgent(name)` a `HerdrAdapter` (`herdr agent focus <name>`, devuelve `agent_info`; `agent_not_found` si no existe), con fake y suite de contrato.
  - `POST /api/blocked/:runId/focus` solo enfoca agentes que el `RunWatcher` ve bloqueados. Así la UI no puede mover la vista de herdr a un agente cualquiera. Respuestas: 204; 404 `not_blocked`; 409 `agent_gone` si herdr ya no tiene el agente; 502 `herdr_error` ante otro fallo; 503 `focus_unavailable` sin herdr (`createApp({ focus })`).
  - La bandeja muestra además el comando `herdr agent focus <name>`, por si la UI corre en otra máquina que el herdr del humano.
  - El permiso se responde en herdr. LunasQ no lo contesta (ADR uw-22-preguntas).
- **Composición.** `startRuntime` no pasaba `questions` ni `blocked` a `createApp`, así que en el servidor real responder daba 503 y la lista de bloqueos salía vacía. Ahora pasa `orchestrator.questions`, `orchestrator.watcher.blocked()` y `herdr.focusAgent`.
- **Actualización en vivo.**
  - El stream de cambios (`/api/stream`) también invalida `["questions"]` y `["blocked"]`: una pregunta nueva o respondida deja eventos en el log de la tarea.
  - Los bloqueos viven en memoria del `RunWatcher` y no dejan eventos. Por eso la consulta de bloqueos se refresca cada 5 s (`BLOCKED_REFRESH_MS`).
  - La UI se suscribe al stream de notificaciones (`/api/notifications/stream`, ADR 0009) y cada `notification` invalida la bandeja. Las notificaciones no se pintan como toasts: la bandeja es la vista de lo pendiente y herdr ya avisa.

## Consecuencias

- Un bloqueo tarda hasta 5 s en aparecer o desaparecer de la bandeja. Si hiciera falta inmediatez, el `RunWatcher` tendría que publicar sus cambios en un stream.
- Editar la spec como JSON exige conocer su forma. Los errores de validación del servidor guían la corrección, pero un editor estructurado sería más amable; queda para después del piloto (UW-29).
- `FakeApi` (`packages/web/test/fake-api.ts`) responde las rutas de preguntas, bloqueos, foco y editar y aprobar, con los mismos rechazos del servidor.
