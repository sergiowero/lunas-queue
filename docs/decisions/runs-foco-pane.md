# Foco del pane desde las tablas de Runs

- Estado: aceptada
- Fecha: 2026-11-01
- Código: `packages/server/src/api/runs.ts`, `packages/web/src/components/pane-focus-button.tsx`, `packages/web/src/components/task/runs.tsx`, `packages/web/src/pages/in-progress.tsx`

## Contexto

El panel de Runs del detalle y la pestaña En curso muestran el pane id de cada Run, pero para llegar al agente el humano tenía que copiar el id y buscarlo en herdr. La bandeja ya enfoca agentes bloqueados ([ADR uw-27-bandeja](uw-27-bandeja.md)) con `HerdrAdapter.focusAgent`, pero solo para los que el `RunWatcher` ve bloqueados.

## Decisión

- **El pane id es un botón** que enfoca el agente del Run en herdr. Lo comparten el panel de Runs y En curso (último Run de cada tarea) con `PaneFocusButton`.
- **Ruta `POST /api/runs/:runId/focus`.** Recibe el `runId` y resuelve el nombre del agente desde la base (`Run.herdrName`), así la UI no puede mover herdr a un agente cualquiera: solo se enfocan agentes de Runs registrados por LunasQ. Reutiliza el `focus` que `startRuntime` ya pasa a `createApp`.
- **Respuestas:** 204; 404 `not_found` si el Run no existe; 409 `no_pane` si no tiene `herdrPane` o `herdrName`; 409 `agent_gone` si herdr no tiene el agente (`agent_not_found`); 502 `herdr_error` ante otro fallo de herdr; 503 `focus_unavailable` sin herdr. La ruta no escribe en la base ni en el Event log: es repetible.
- **UI.** Un Run sin pane o sin nombre de agente conserva «—» como texto, sin botón; en En curso, «…» y «error» siguen siendo texto. El botón se deshabilita mientras la petición está en curso y un fallo se muestra junto a ese pane, sin tocar el resto de la tabla. Su nombre accesible es «Enfocar pane <id> en herdr».
- **Sin refresco tras un error.** A diferencia de la bandeja, las tablas leen la base, no el estado en memoria del `RunWatcher`: un `agent_gone` no deja datos viejos que refrescar. Un Run cerrado sigue mostrando su pane id (histórico) y enfocarlo responde `agent_gone`.
- `FakeApi` soporta la ruta con los mismos rechazos y registra el agente enfocado en `focused`.

## Consecuencias

- Los panes de Runs ya terminados también son botones; al hacer clic el humano ve «ya no está en herdr» en vez de un id inerte.
- Igual que en la bandeja, el foco mueve el herdr de la máquina del servidor. Si la UI corre en otra máquina, el botón no sirve y el humano usa `herdr agent focus <nombre>`.
