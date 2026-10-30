# UW-29 — Piloto end-to-end y suite e2e

- Estado: aceptada
- Fecha: 2026-10-30
- Unidad: UW-29 · Código: `packages/e2e/` (`harness/`, `tests/`, `playwright.config.ts`), `packages/server/src/runtime/`, `packages/cli/`

## Contexto

UW-29 pide dos cosas: un piloto en un proyecto real (3 tareas con dependencias, un rework, una pregunta y un hook) y una suite e2e de la UI que corra en CI contra un servidor con el fake de herdr. El piloto real necesita herdr, Claude Code y `gh` de una máquina concreta y gasta tokens, así que no corre en CI. La suite automatiza el mismo guion con todo lo que sí se puede reproducir.

## Decisión

- **Un servidor completo, con fakes solo donde está lo externo.** `packages/e2e/harness/main.ts` arranca `startRuntime` (base SQLite, API, MCP, scheduler, dispatcher, reconciliación, entrega, hooks, PR poller y front end) con `FakeGitHub` y un herdr falso. Todo lo demás es real: git contra un `origin` bare en un directorio temporal, worktrees reales, el gate de tests (`sh test.sh` en un pane) y los hooks leídos de `origin/main`.
- **Agente guionado en vez de Claude Code.** `ScriptedHerdr` extiende `FakeHerdr`: crea los worktrees con `git worktree add` y, por cada prompt que recibe un agente, corre un guion (`harness/agent.ts`) que habla con el LunasQ MCP real con el run token del pane (`get_task_context`, `ask_human`, `submit_spec`, `update_checklist`, `submit_for_verification`, `submit_verdict`), hace un commit real en el worktree y reporta los hooks `SubagentStart/Stop` de los revisores. El turno termina con el agente en `done`. El guion lo decide la fase y el intent: `[pregunta]` hace que el refinamiento pregunte y `[rework]` que el primer veredicto sea reject. Prueba el servidor, no a Claude Code; lo que depende del modelo real lo cubre el piloto manual (`docs/pilot.md`) y los `test:claude` de cada paquete.
- **Los humanos son el navegador.** Playwright crea las tareas (con sus dependencias), responde la pregunta y aprueba las specs desde la UI. El merge lo hace el test por un servidor de control (`POST /merge/:taskId`), como lo haría GitHub: marca el PR del fake como mergeado y avanza `main` del origin, y solo si la rama es un avance directo de `main` (la entrega la rebasó); un PR que no lo sea falla el piloto, porque no sería mergeable.
- **Criterio «PR mergeable» comprobable.** Las tres tareas terminan en `completed`, con PR mergeado en el fake y `main` del origin avanzado por cada una. B depende de A y C de B: B y C permanecen en `draft` y sin Runs durante varios ticks del scheduler mientras su dependencia no está mergeada, y su worktree nace de la base ya mergeada.
- **Seams en `startRuntime`.** Para componer el servidor del piloto sin copiar el runtime, `RuntimeOptions` suma `webRoot` (estáticos del front end), `prPollIntervalMs` y `scheduler` (`tickIntervalMs`). `lunasq start` pasa `webRoot` cuando encuentra el build (`bin/../web` en el paquete publicado o `packages/web/dist/app` en el repo) y `buildPackage` arma el front end de nuevo e incluye el resultado en `dist/web`.
- **Cierre ordenado.** El `webServer` usa `gracefulShutdown` (SIGTERM) para que el harness cierre el runtime y borre su directorio temporal; el harness fija una identidad de committer de git y aísla la config global, porque la entrega reescribe commits y CI no tiene identidad.
- **Playwright es dependencia de desarrollo de `packages/e2e`** (`@playwright/test`, ya listado en `docs/tech-stack.md`). `pnpm e2e` arma el front end y corre la suite en serie (`mode: serial`, un worker, sin reintentos): los tests comparten el servidor, la base y el DAG, así que dependen del orden y no se corren sueltos con `--grep`; el job de CI instala Chromium y sube el reporte si falla. `packages/e2e` entra a la matriz de fronteras (`server`, `adapters`, `schemas`; nadie lo importa) en `tooling/boundaries.test.ts`, `biome.json` y `docs/tech-stack.md`. Vitest solo corre `harness/**/*.test.ts`.

## Hallazgos del piloto

Se corrigieron en esta unidad:

- **herdr real:** un agente sin `name` (sesión de Claude Code abierta a mano) hacía fallar todo `snapshot` con `invalid_type`. El adapter ahora los tolera y los descarta (hallazgo de [ADR uw-28-instalador](uw-28-instalador.md)).
- **Carrera de `git fetch`:** al mergear una tarea, el hook `after_merge` y el worktree del dependiente que se libera hacen `fetch` del mismo ref `origin/main` a la vez; git abortaba al segundo con «incorrect old value provided» y el hook quedaba bloqueado sin ejecutar scripts (ni error visible). `RealGit.fetch` repite hasta 4 veces solo ante ese error.
- **`lunasq start` no servía el front end:** `startRuntime` no pasaba `webRoot` a `createApp` y la UI quedaba sin servir.

Quedan como tareas nuevas, para encolar en LunasQ (`docs/pilot.md`):

- **Hooks sin conectar a su fase:** `before_refinement`, `after_refinement`, `before_implementation` y `on_failure` están en el esquema y en `docs/design.md`, pero nada los ejecuta. Solo corren `after_implementation`, `before_verification`, `after_verification`, `before_delivery`, `after_delivery` y `after_merge`. Un hook en cualquiera de los cuatro primeros no hace nada y no avisa.
- **Crear una tarea no despierta al scheduler:** la tarea espera hasta el siguiente tick (30 s por defecto) para empezar el refinamiento. La UI muestra «en cola» sin explicar la espera.

## Verificación

- `pnpm e2e` (6 tests de Playwright, ~25 s): crear las 3 tareas con dependencias desde la UI y verlas en el DAG; la pregunta del refinamiento llega a la bandeja, se responde y se aprueba la spec; A llega a `completed` con PR y evidencia; los hooks `before_verification` (exit 0) y `after_implementation` (exit 1, `warn`) aparecen en la vista de hooks; B espera el merge de A y pasa por un reject (2 Runs de implementación y 2 de verificación, iteración 1); C llega al final; las tres quedan con PR mergeado y `after_merge` corrió una vez por tarea (Event log).
- Unitarios: el adapter de herdr descarta agentes sin nombre, `startRuntime` sirve estáticos solo con `webRoot`, `lunasq start` lo pasa, el paquete npm incluye `web/`, y el fixture del piloto (git real) rechaza un PR que no es avance directo.
- `RealGit.fetch` repite ante la carrera por el ref y no repite otros fallos.

## Pendiente

El piloto en un proyecto real no se ejecutó: necesita herdr, Claude Code y `gh` reales y gasta tokens. Queda como guía en [pilot.md](../pilot.md), para correrlo una vez por versión; los hallazgos de arriba que no se corrigieron aquí están listos para encolar como tareas en LunasQ.
