# UW-25 — Vistas de DAG y de hooks: grafo de aristas reales, hooks de la rama base y ejecuciones del Event log

- Estado: aceptada
- Fecha: 2026-10-30
- Unidad: UW-25 · Código: `TaskViewRepository.graph` y `hookExecutions` en `packages/db/src/task-views.ts`, `TaskGraph` y `ProjectHooksView` en `packages/schemas/src/{views,hooks}.ts`, `packages/server/src/api/hooks.ts` y `graphRoutes`, `packages/web/src/pages/{dag,hooks}.tsx`

## Contexto

`docs/design.md` pide una vista de DAG de dependencias y una vista de hooks por proyecto (contenido de `lunasq/hooks/` en la rama base y últimas ejecuciones por tarea). El ADR uw-10-hooks dejó `HookService.listHooks` y los eventos `hook.executed`, y dejó las rutas y la vista para esta unidad. No fijaban qué forma tiene el grafo, qué pasa con las dependencias entre proyectos ni de dónde salen las ejecuciones.

## Decisión

- **El grafo son las filas de `task_dependencies`.** `GET /api/graph[?projectId=]` devuelve `{ nodes, edges }`; el front end no deriva aristas de otras respuestas. Con `projectId`, los nodos son las tareas del proyecto más las de otros proyectos al otro extremo de una arista suya, para que una dependencia entre proyectos no quede con un extremo faltante. Sin él, todas las tareas. Se incluyen las terminales: una dependencia ya cumplida sigue siendo parte del historial del DAG. Nodos y aristas se leen en una sola transacción.
- **Layout con dagre de izquierda a derecha** (`layoutGraph`, función pura con tests): la flecha va de lo que se debe terminar a lo que espera por ello. Los nodos tienen tamaño fijo conocido, así React Flow los dibuja sin medirlos. La dependencia `@dagrejs/dagre` es el dagre mantenido que `docs/tech-stack.md` ya preveía; `@xyflow/react` también estaba en el stack.
- **Lista accesible de dependencias junto al grafo.** Repite cada arista como «A depende de B» y marca las de entre proyectos. Es el equivalente en texto del canvas, que los lectores de pantalla no recorren, y lo que los tests verifican: jsdom no mide los handles de React Flow y no dibuja las aristas del SVG.
- **Hooks: `GET /api/projects/:id/hooks`** devuelve `HookService.listHooks` (scripts, política, timeout y contenido de la rama base, `baseRef` y `configError`). Es lectura git con `fetch`, así que un fallo (sin red, sin rama base) responde 502 `hooks_unavailable` y la vista lo muestra; sin servicio de hooks en `createApp`, 503. Un proyecto desconocido es 404.
- **Ejecuciones: `GET /api/projects/:id/hooks/executions?limit=`** sale del Event log (`hook.executed` de las tareas del proyecto), no de una tabla nueva: es la misma fuente que usará el archivo de evidencia. La consulta (funciones de ventana sobre `json_extract` del payload) deja la ejecución más reciente de cada tarea en cada punto y script, y a lo más `limit` tareas por hook (10 por defecto, 100 como máximo). El tope es por hook y no por proyecto, para que un hook que corre poco (`after_merge`) no desaparezca detrás de los eventos de otros. Un payload que no cumple el esquema se salta. Mientras carga o si la consulta falla, la tarjeta de cada hook lo dice en vez de afirmar «Sin ejecuciones». Un script con ejecuciones que ya no está en la rama base se muestra marcado «ya no está en la rama base».
- **Solo lectura.** Ninguna ruta edita hooks ni aristas; los hooks se cambian por PR y las aristas siguen en `PUT/DELETE /api/tasks/:id/dependencies/:dependsOnId` (UW-07).
- **Refresco.** Un `change` del stream SSE invalida el grafo y las ejecuciones de hooks. El contenido de los hooks viene de git, no de eventos, y no se invalida: se refresca al volver a abrir la vista.

## Consecuencias

- Abrir la vista de hooks hace un `fetch` al remoto del proyecto, igual que cada punto de hook; con muchos proyectos y sin red la vista responde 502 por proyecto, no globalmente.
- El grafo global crece con el número de tareas. Con cientos de nodos, el layout de dagre en el navegador será lo primero en notarse; si pasa, se filtra por proyecto (ya soportado) o se oculta lo terminado.
- React Flow y dagre pesan unos 226 kB (74 kB comprimidos); la página de DAG se carga con `lazyRouteComponent`, así el resto de las vistas no los descarga.
