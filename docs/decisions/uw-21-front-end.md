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
  - `GET /api/tasks/:id/evidence` lee `lunasq/tasks/{id}.md` del worktree de la tarea y responde `404 evidence_not_found` si no hay worktree o no hay archivo. El archivo lo escribe UW-24.
    - **Limitación:** cuando el worktree se limpia tras el PR, la evidencia ya no se lee desde LunasQ. La UI lo dice y la evidencia queda en el PR. Leerla desde la branch o el PR queda pendiente para cuando UW-24 o UW-26 fijen dónde vive después de la entrega.
  - Los esquemas de respuesta viven en `@lunasq/schemas` (`views.ts`).
- **Estáticos.** `createApp({ webRoot })` sirve el build de `packages/web` con `serveStatic` de `@hono/node-server`. Hace fallback a `index.html` solo en GET de rutas del cliente. Quedan fuera `/api`, `/mcp`, `/hooks/subagent`, `/assets` y sus subrutas, y las rutas con extensión de archivo, así sus 404 se conservan. El `listen` y la ruta del build quedan para `lunasq start` (UW-28). El build va a `packages/web/dist/app` porque `dist/` también recibe las declaraciones de `tsc -b`.
- **Actualización en vivo por refresco periódico.** El `QueryClient` refresca cada 3 s y al volver el foco. El stream SSE de hoy solo lleva notificaciones y no está montado. La invalidación por SSE que pide `docs/tech-stack.md` llega con la bandeja (UW-27), que la tiene en su alcance. Entonces se reemplaza `refetchInterval` en `main.tsx`.
- **Gate de spec en el detalle.** Para seguir la tarea sin la API, el panel de spec permite **aprobar** y **pedir cambios** sobre la última versión pendiente de una tarea en `refined`. Si llega una versión nueva mientras se revisa una anterior, el panel pasa a la nueva para que el gate no quede oculto. Editar y aprobar, junto con la vista unificada de todo lo que espera al humano, queda para la bandeja (UW-27).
- **Alta de tareas.** El formulario ofrece como dependencias las tareas vivas del mismo proyecto. Las dependencias entre proyectos (ADR 0010) siguen disponibles por la API y la vista de DAG (UW-25) las mostrará.
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
