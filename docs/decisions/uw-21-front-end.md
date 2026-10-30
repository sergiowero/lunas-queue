# UW-21 — Front end base y rutas de lectura

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-21 · Código: `packages/web/`, `packages/schemas/src/views.ts`, `packages/db/src/task-views.ts`, `packages/server/src/api/views.ts`, `packages/server/src/web/static.ts`

## Contexto

El criterio de UW-21 es que una tarea se cree y se siga de punta a punta sin usar la API a mano. `docs/design.md` (§Front end: vistas mínimas, §Consumo y §Auditoría) pide un tablero por proyecto, la cola global ordenada por score y un detalle de tarea con spec y versiones, Runs, Event log, usage y evidencia. Hasta ahora la API solo exponía proyectos, tareas, DAG y specs. Faltaban las lecturas de Runs, eventos, usage, evidencia y cola, y el servidor no servía el front end.

## Decisión

- **Rutas de lectura en `server`.** La unidad está asignada a `packages/web`, pero sin estas lecturas el criterio no se cumple. Son rutas finas sobre un repositorio de solo lectura, `TaskViewRepository` en `db`:
  - `GET /api/queue?projectId=` lista las tareas vivas. Primero va el ready set, en el orden y con el score de `rankReady` del dominio y la misma `SchedulerConfig` que el scheduler (`createApp({ scheduler })`). Después van las demás tareas vivas, en el orden del listado de tareas (prioridad y antigüedad), con `score: null`. Cada entrada trae su usage total. El snapshot, el listado y el usage se leen en una sola transacción, así el ready set coincide con el estado que se muestra.
  - `GET /api/tasks/:id/runs` devuelve `RunView`, que no incluye `runToken`: el token solo vive en el pane. Tampoco incluye `launchedAt` ni `contextReadAt`, que son detalles internos del dispatcher y del MCP.
  - `GET /api/tasks/:id/events` devuelve el Event log en orden de escritura.
  - `GET /api/tasks/:id/usage` suma los `usage_records` en total y por Run. El costo solo se suma cuando todos los registros del grupo lo traen; si no, vale `null`, porque un total parcial se leería como completo. Hasta que llegue UW-20 la respuesta es cero.
  - `GET /api/tasks/:id/evidence` busca `lunasq/tasks/{id}.md` en este orden:
    1. En el worktree de la tarea.
    2. Si el worktree ya se limpió, en la branch de la tarea (`origin/<branch>` y luego la local) dentro del repo del proyecto, con el adapter de git.
    3. Tras el merge, cuando la branch puede estar borrada, en `origin/<rama base>`.

    La respuesta indica el origen (`source: worktree | branch | base`) y la ruta (`<ref>:<ruta>` en git). La búsqueda no hace fetch, porque una lectura de la UI no debe tocar la red: usa los refs que el poller de PR y la entrega ya trajeron. Un ref ausente o un repo inaccesible cuentan como «no está» (`404 evidence_not_found`). El archivo lo escribe y lo commitea UW-24.
  - Los esquemas de respuesta viven en `@lunasq/schemas` (`views.ts`).
- **Estáticos.** `createApp({ webRoot })` sirve el build de `packages/web` con `serveStatic` de `@hono/node-server`. Hace fallback a `index.html` solo en GET de rutas del cliente. Quedan fuera `/api`, `/mcp`, `/hooks/subagent`, `/assets` y sus subrutas, y las rutas con extensión de archivo, así sus 404 se conservan. El `listen` y la ruta del build quedan para `lunasq start` (UW-28). El build va a `packages/web/dist/app` porque `dist/` también recibe las declaraciones de `tsc -b`.
- **Actualización en vivo por SSE.** `GET /api/stream` emite `change` con `{ taskIds }` cada vez que aparecen eventos nuevos en el Event log.
  - Toda mutación de una tarea deja evento (ADR 0007), así que el Event log basta como fuente. El stream lo consulta cada 500 ms con una lectura por id indexado, sin acoplarse al publicador del outbox, que `createApp` no compone.
  - El id del mensaje SSE es el del último evento: con `Last-Event-ID`, una reconexión recupera lo que se perdió.
  - El front end (`lib/live.ts`) invalida las listas y las consultas de cada tarea afectada.
  - El refresco periódico del `QueryClient` queda en 30 s, como red de seguridad si el stream se cae.
  - Las notificaciones de herdr y de la UI (`notificationRoutes`) siguen siendo otro stream, y la bandeja (UW-27) decidirá si las monta.
- **Gate de spec en el detalle.** Para seguir la tarea sin la API, el panel de spec permite **aprobar** y **pedir cambios** sobre la última versión pendiente de una tarea en `refined`. Si llega una versión nueva mientras se revisa una anterior, el panel pasa a la nueva para que el gate no quede oculto. Editar y aprobar, junto con la vista unificada de todo lo que espera al humano, queda para la bandeja (UW-27).
- **Alta de tareas.** El formulario ofrece como dependencias las tareas vivas de todos los proyectos. Primero aparecen las del proyecto elegido, y las de otros proyectos se agrupan bajo «<proyecto> · otro proyecto», porque son un riesgo (ADR 0010), igual que en el detalle.
- **Pestaña En curso.** `/in-progress` («En curso» en la navegación) lista las tareas en `in_progress` de todos los proyectos, con cualquier sub-estado, su proyecto, sub-estado y prioridad, y un filtro por proyecto como el de la cola. No agrega rutas: lee `GET /api/tasks` y filtra por estado en el cliente, así el stream en vivo la refresca al invalidar `["tasks"]`. Sin tareas en curso muestra un mensaje en vez de la tabla.
- **Color de los estados.** `StateBadges` pinta `in_progress` con la variante `info` del Badge (azul, tokens `--color-info` en `index.css`) para que resalte en la cola, el detalle y el DAG; `needs_human` sigue en `destructive` y los demás estados en `secondary`. La columna Estado de la cola usa `StateBadges` en lugar del texto plano. El Badge expone su variante en `data-variant` para que los tests no dependan de las clases.
- **Errores.** El `QueryClient` no reintenta los 4xx: un 404 se muestra de inmediato.
- **Detalle de implementación.**
  - Las rutas de TanStack Router se definen en código, sin el plugin generador, y cada página lee sus parámetros con `getRouteApi`.
  - Los componentes de shadcn/ui (button, badge, card, input, table) se escriben a mano sobre Tailwind 4, sin Radix: ninguno necesita primitivas accesibles complejas todavía.
  - `web` importa solo tipos de `@lunasq/schemas`. Un import de valor mete zod en el bundle.
  - La evidencia se renderiza con `react-markdown`, que no interpreta HTML crudo, así el markdown que escribe un agente no puede inyectar scripts.
- **Tests.**
  - Las rutas nuevas se prueban en `server` y en `db` contra SQLite.
  - El front end se prueba con Vitest, Testing Library y jsdom contra `FakeApi` (`packages/web/test/fake-api.ts`). Es una API en memoria tipada con los mismos esquemas, que valida con `TaskCreate` y responde los 400, 422 y 409 del servidor real: gate de spec, cancelar una tarea terminal y referencias inexistentes. `web` no puede importar `server`, así que el fake no se reemplaza por la app real en estos tests.
  - `test/flow.test.tsx` cubre el criterio de terminado: alta, refinamiento, aprobación, implementación, verificación y PR, todo desde la UI.
  - La suite end-to-end contra el servidor real con Playwright es de UW-29.

## Dependencias nuevas

| Paquete | Dónde | Por qué |
| --- | --- | --- |
| `@hono/node-server` | `server` | `serveStatic` para Node; el mismo paquete dará el `listen` de UW-28 |
| `@tanstack/react-table` 8.x | `web` | Elegida en tech-stack; se fija la línea 8 porque la 9 cambió su API y la 8 es la que conoce el equipo |
| `class-variance-authority`, `clsx`, `tailwind-merge` | `web` | Utilidades estándar de shadcn/ui para variantes y clases |
| `react-markdown` | `web` | Render seguro del archivo de evidencia («render de markdown» en tech-stack) |
| `@tailwindcss/vite`, `@vitejs/plugin-react` | `web` (dev) | Plugins de Vite para Tailwind 4 y React |
| `jsdom`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event` | `web` (dev) | Tests de componentes y flujos («Vitest + Testing Library» en tech-stack) |

## Consecuencias

- La cola muestra el mismo score con el que despacha el scheduler, siempre que el servidor y el scheduler compartan configuración. Quien compone el servidor (UW-28) debe pasar la misma `SchedulerConfig` a los dos.
- `pnpm --filter @lunasq/web dev` levanta Vite con un proxy de `/api` hacia `LUNASQ_API` (por defecto `http://localhost:4310`), para desarrollar contra un servidor en marcha.
- El bundle pesa unos 550 kB (170 kB con gzip) en un solo chunk. Para una herramienta local se acepta. Si crece, se divide por ruta.
