# 0013 — Specs versionadas y gate de aprobación

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-12 · Código: `packages/schemas/src/spec.ts`, `packages/domain/src/spec-diff.ts`, `packages/db/src/specs.ts`, `packages/db/drizzle/0002_specs_aprobacion.sql`, `packages/server/src/api/specs.ts`

## Contexto

`docs/design.md` (§Modelo de dominio y §Human‑in‑the‑loop) pide specs versionadas con modelo de dominio, una aprobación ligada a una versión concreta, pedir cambios con comentarios, editar y aprobar, y diff entre versiones. ADR 0007 deja a UW-12 los hechos de los guards `specComplete`, `hasComments` y `specApproved`. El diseño no decía qué versión se puede aprobar, cómo se registra quién escribió cada versión ni qué pasa con la versión que el humano editó.

## Decisión

- **Un solo esquema de contenido.** `SpecContent` (modelo de dominio, requerimientos, criterios y task list) usa el mismo shape y las mismas reglas de referencias que el body del handoff de refinamiento (`specContentShape`, `checkSpecReferences`). Las reglas exigen claves únicas en todo lo que el diff compara por clave: ids de criterios y tareas, términos del glosario y nombres de agregados y eventos. Esto también vuelve más estricto el handoff de refinamiento. Los supuestos van en el handoff, no en la spec. La columna `acceptance_criteria` guarda los criterios del handoff (`id`, `given`, `when`, `outcome`), no el `{id, text}` provisional de UW-01.
- **Versiones.** Cada entrega del refinador crea la versión `max + 1` de la tarea. Las escrituras corren en una transacción `IMMEDIATE` que guarda la versión, su evento y la transición de la tarea con `applyTransition`. `applyTransition` es el cuerpo de `transitionTask`, extraído para correr dentro de una transacción abierta. Si la máquina de estados rechaza, la transacción se revierte y no queda versión, evento ni cambio de aprobación.
- **Solo se decide sobre la última versión pendiente.** Aprobar, pedir cambios o editar una versión que no es la última responde `stale_version`. Si la versión ya se aprobó o ya tiene cambios pedidos, responde `spec_not_pending`. Así la aprobación queda ligada a la versión que el humano vio, y repetir una decisión no duplica efectos.
- **Una aprobada por tarea.** El índice único parcial `specs_one_approved_per_task` lo garantiza en la base. `approved(taskId)` es la versión que leen implementación y verificación (UW-15).
- **Pedir cambios.** La versión queda en `changes_requested` con los comentarios recortados en `review_comments`, y la tarea va de refined a draft/queued. Los comentarios también van en el evento `spec.changes_requested`. Sin comentarios, el guard `hasComments` rechaza y no se escribe nada.
- **Editar y aprobar.** El humano parte de la última versión pendiente. Se crea la versión siguiente con autor humano, ya aprobada, en el mismo paso. La versión base queda `pending` y superada: no se puede aprobar porque ya no es la última.
- **Autor.** La columna `created_by` (actor, default `agent`, con CHECK) dice si la versión la escribió el refinador o el humano. `approved_by` es siempre `human` en v1 y solo la escribe `SpecRepository`. Está tipada con el enum de actores, pero sin CHECK: agregarlo obliga a recrear la tabla en SQLite, y no vale la pena por un valor fijo.
- **Eventos.** `spec.version_created` (`specId`, `version`, `basedOn`, con el autor como actor), `spec.approved` y `spec.changes_requested`. Sus payloads se validan con su esquema antes de escribirlos. Se escriben antes del `task.transitioned` de la misma escritura. Solo `task.transitioned` va al outbox.
- **Diff.** `diffSpecContent` (dominio puro) compara criterios, tareas, términos, agregados y eventos por clave (agregados, quitados y cambiados) y los requerimientos e invariantes por texto. Reordenar no es un cambio. Por defecto compara contra la versión anterior; la primera versión aparece toda como agregada.
- **Migración.** `0002_specs_aprobacion` se editó a mano. drizzle-kit recreaba la tabla y copiaba `created_by` desde la tabla vieja, que no la tiene. `ADD COLUMN` con su CHECK y el índice parcial bastan, y el snapshot sigue igual al esquema.
- **HTTP.** Bajo `/api/tasks/:id/specs`:
  - `GET /`, `GET /:version` y `GET /:version/diff?against=`.
  - `POST /:version/approve`, `POST /:version/request-changes` (`{comments}`) y `POST /:version/edit-and-approve` (`{content}`).
  - Las acciones responden `{spec, task}`.
  - Errores: 400 `invalid_json` o `invalid_input` (también con una versión que no es un entero positivo); 404 si no existe la tarea o la versión; 409 para `stale_version`, `spec_not_pending` y las transiciones rechazadas.
  - Repetir una decisión no duplica efectos, pero responde 409, no 200: `spec_not_pending` al repetir aprobar o pedir cambios, y `stale_version` al reintentar editar y aprobar, porque la versión base ya fue superada por la editada. Si un cliente pierde la respuesta, relee la versión con `GET` para saber si su acción se aplicó; UW-21 y UW-27 lo hacen así.
  - La versión del refinador no entra por HTTP sino por `submit_spec` del LunasQ MCP (UW-15), que usa `SpecRepository.submit`.

## Consecuencias

- UW-15 valida el handoff con `parseHandoff` y llama `SpecRepository.submit` con el body sin supuestos. `get_task_context` lee `approved()` y, en una nueva ronda de refinamiento, los comentarios de la última versión con `changes_requested`.
- UW-21 y UW-27 muestran versiones, autor, diff y las tres acciones del gate con estas rutas.
- Las versiones superadas por una edición quedan `pending`. La UI debe mostrar solo la última como decidible.
