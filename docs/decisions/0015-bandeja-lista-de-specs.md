# 0015 — La bandeja lista las specs por aprobar y el gate vive en el detalle

- Estado: aceptada
- Fecha: 2026-10-30
- Supera: la decisión de [ADR uw-27-bandeja](uw-27-bandeja.md) de montar `SpecVersions` en la bandeja
- Código: `packages/web/src/pages/inbox.tsx`, `packages/web/src/components/task/spec.tsx`

## Contexto

ADR uw-27-bandeja montaba en «Specs por aprobar» el panel completo de cada spec (versiones, contenido, diff y gate). Con varias tareas en `refined` la bandeja se vuelve una página larga y difícil de recorrer: el humano pidió que la sección sea solo una lista para elegir qué revisar.

## Decisión

- **«Specs por aprobar» es una lista.** Una fila (`li`) por tarea en `refined`, ordenadas como antes (`updatedAt` ascendente), con el intent como enlace a `/tasks/$taskId` y el nombre del proyecto. Sin versiones, contenido, diff ni botones.
- **El gate vive solo en el detalle de la tarea.** Aprobar, pedir cambios y editar y aprobar se hacen en la sección «Spec» del detalle, con el mismo `SpecVersions` y el mismo comportamiento (ADR 0013, uw-27-bandeja §Errores). Al salir de `refined` la tarea deja de aparecer en la lista.
- **La bandeja no pide specs.** Como no monta `SpecVersions`, no hace `GET /api/tasks/:id/specs` por tarea; la lista sale de `GET /api/tasks`, como antes.
- **Sin cambios** en los estados de carga, error y vacío de la sección, en el total del menú (sigue contando las tareas en `refined`) ni en las secciones de preguntas y bloqueos.

## Consecuencias

- Revisar una spec desde la bandeja cuesta un clic más, a cambio de una bandeja que se recorre de un vistazo.
- Los tests del gate (editar y aprobar, JSON inválido, issues del servidor, error de la última acción) viven en `task-detail.test.tsx`; `inbox.test.tsx` cubre la lista, la navegación al detalle y que la tarea sale de la bandeja tras decidir.
