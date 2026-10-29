# 0010 — API de tareas y DAG de dependencias

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-07 · Código: `packages/schemas/src/task.ts`, `packages/domain/src/dependency-graph.ts`, `packages/db/src/tasks.ts`, `packages/server/src/api/tasks.ts`

## Contexto

`docs/design.md` (§Modelo de dominio y §Scheduler) pide tareas con intent, tags y prioridad, cancelación y un DAG de dependencias que rechaza las aristas que cierran un ciclo; el scheduler (UW-13) necesita ancestros y descendientes. No decía cuándo se pueden editar las aristas, qué pasa con dependencias canceladas ni cómo se auditan los cambios que no son transiciones.

## Decisión

- **Reglas del DAG en el dominio.** `DependencyGraph` (TypeScript puro, inmutable) se construye con las aristas y expone dependencias y dependientes directos, `ancestors` (de las que depende, transitivamente) y `descendants` (las que bloquea: el boost por desbloqueo), ambos por distancia y sin repetir. `findCycle(edge)` devuelve el camino más corto que cerraría la arista, de la dependiente a sí misma (`[a, a]` si depende de sí misma), o null.
- **Puerto del scheduler.** `DependencyGraphReader.snapshot()` devuelve el DAG completo, incluidas las aristas entre proyectos; el scheduler lo lee una vez por tick. `TaskRepository` lo implementa e `InMemoryDependencyGraphReader` sirve en tests; la suite de contrato (`@lunasq/domain/testing`) corre contra ambos. En v1 cargar todas las aristas basta; si crece, se cambia la implementación sin tocar el puerto.
- **Aristas solo en draft.** Una arista se agrega solo si la dependiente está en draft: el diseño valida las dependencias antes de refinar. Quitar una arista se permite en cualquier estado no terminal. Repetir una arista existente es idempotente: `PUT` responde 200 sin evento nuevo, y eso se comprueba antes que el estado, así que repetirla en una tarea que ya salió de draft también responde 200. Un `DELETE` de una arista que no existe responde 404 sin escribir nada: el efecto no se duplica, pero quien llama sabe que no había arista.
- **Dependencias válidas.** No se puede depender de una tarea cancelada: la dependiente quedaría bloqueada para siempre. Una tarea completed sí es dependencia válida. Las dependencias entre proyectos se aceptan y se marcan `crossProject` en `GET /api/tasks/:id/dependencies` y en los eventos (`task.created` y `task.dependency_*`), para que la UI las muestre como riesgo.
- **Concurrencia.** Crear tareas, editar y agregar o quitar aristas corre en transacciones `IMMEDIATE`: la validación de ciclos lee las aristas con el lock de escritura tomado, así dos procesos (servidor y CLI) no validan a la vez dos aristas que juntas cerrarían un ciclo. Un test con dos conexiones lo comprueba: con el lock tomado por otra, `addDependency` falla sin ejecutar ninguna lectura. `dependencies` lee en una transacción para ver un estado coherente.
- **Creación atómica.** `POST /api/tasks` acepta `dependsOn` y crea tarea, aristas y evento en la misma transacción; si una referencia no existe o está cancelada no se escribe nada. Una tarea nueva no tiene dependientes, así que sus aristas iniciales no pueden cerrar un ciclo. Nace en draft con el sub‑estado de `subStateFor("draft")`.
- **Auditoría.** Toda escritura deja su evento con actor `human`: `task.created` (lo capturado, con cada dependencia inicial y su `crossProject`), `task.updated` (solo los campos que cambiaron, con `from` y `to`; sin cambios no hay evento), `task.dependency_added` y `task.dependency_removed` (en la dependiente, con `dependsOnId` y `crossProject`). Los payloads están en `@lunasq/schemas`.
- **Edición.** `PATCH` cambia intent, tags y prioridad; estado, proyecto y los campos de solo lectura se rechazan con 400. Las tareas terminales no se editan (409 `task_terminal`).
- **Cancelación.** `POST /api/tasks/:id/cancel` (nota opcional) usa `transitionTask` con `cancel` y actor `human` (ADR 0007). Detener y limpiar el agente vivo es del dispatcher y la reconciliación (UW-16, UW-17), que reaccionan al evento. No hay `DELETE` de tareas: se cancelan (ADR 0005).
- **Errores HTTP.** 400 `invalid_json` o `invalid_input`; 404 `not_found` si la tarea de la ruta no existe (también al quitar una arista que no existe); 422 si una referencia no existe (`project_not_found`, `dependency_not_found`, `caused_by_not_found`); 409 para `cycle` (con `cycle`, el camino), `task_not_draft`, `task_terminal`, `dependency_cancelled` y las transiciones rechazadas (`invalid_transition`).

## Consecuencias

- UW-13 calcula el ready set y el boost con `DependencyGraphReader`; qué cuenta como dependencia satisfecha (PR mergeado) lo decide UW-13 con UW-14.
- Cancelar una tarea con dependientes los deja esperando una dependencia que nunca se entregará; el diseño solo define el caso del PR cerrado sin merge (Needs human). Queda para UW-13/UW-14 tratar la cancelación igual.
- `server/src/api/http.ts` concentra las ayudas de las rutas que antes vivían en `projects.ts`.
