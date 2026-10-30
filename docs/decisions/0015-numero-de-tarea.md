# 0015 — Número de tarea (#N)

- Estado: aceptada
- Fecha: 2026-10-30
- Tarea: e5f15762-0f14-4b0c-9220-48cf5b882262 · Código: `tasks.number` y `packages/db/drizzle/0007_task_number.sql`, `TaskNumber` y `taskLabel` en `packages/schemas/src/task.ts`, `packages/web/src/components/task-number.tsx`, `packages/web/src/lib/mentions.ts`, `packages/web/src/components/task/intent-text.tsx`

## Contexto

Las tareas se identificaban solo por su UUID. En herdr (título del pane, label del workspace) y en las notificaciones aparecían los 8 primeros caracteres del UUID, difíciles de leer, recordar y mencionar entre tareas. Se pidió un número corto para seguir las tareas, usable con `#` para enlazarlas desde el intent de otra.

## Decisión

- **Número además del UUID.** `tasks.number` es un entero positivo, secuencial y **global** (no por proyecto): `#12` identifica una sola tarea en todo LunasQ, sin necesidad del proyecto. El UUID sigue siendo la identidad en rutas de la API y la UI, llaves foráneas, branch (`lunasq/<uuid>`), nombre del agente en herdr y archivo de evidencia.
- **Asignación.** `TaskRepository.create` toma `max(number) + 1` dentro de su transacción IMMEDIATE, así dos creaciones no leen el mismo máximo. El índice único `tasks_number_unique` rechaza un repetido y un CHECK exige entero positivo. Como las tareas no se borran (la FK de proyecto es `restrict` y no hay API de borrado), cancelar no libera el número: no se reutiliza.
- **Inmutable.** El trigger `tasks_number_immutable` aborta cualquier UPDATE que cambie un número ya asignado; ni edición ni transición lo tocan.
- **Migración 0007.** `ADD COLUMN` (recrear `tasks` borraría en cascada Runs, aristas y usage) y backfill con `row_number()` por `created_at` y `rowid`: las tareas existentes quedan numeradas desde 1 en orden de creación, sin huecos. La columna admite NULL en SQL solo para que el trigger `tasks_assign_number` complete los inserts que no traen número (escrituras fuera del repositorio, como los helpers de tests); toda fila leída tiene número y `Task` lo exige.
- **Dónde se expone.** `Task`, `DependencyLink`, `TaskGraphNode`, `TaskContext.task` (`get_task_context`) y el payload de `task.created` (opcional en el esquema: los eventos anteriores no lo traen).
- **Etiqueta `#N`.** `taskLabel` arma la etiqueta. herdr: título del pane `LunasQ <fase> #N` y label del workspace de la tarea `<proyecto> #N`. Las notificaciones (agente bloqueado, timeout de fase, pregunta abierta, reintentos y loop de verificación agotados) dicen `en #N` en lugar del prefijo del UUID. La UI muestra `#N` junto al intent en tablero, cola, DAG, bandeja, dependencias y detalle; `web` repite el helper porque solo comparte tipos con `schemas`.
- **Menciones.** En el detalle, cada `#N` del intent que corresponde a una tarea existente es un enlace a su detalle. Una mención es `#` y dígitos sin letra, dígito o `#` pegados antes ni letra o dígito pegados después: `#abc`, `a#5`, `#5x` y `#0` son texto, igual que un número sin tarea. Donde el intent ya está dentro de un enlace (tarjetas del tablero, filas de la cola, nodos del DAG) se muestra como texto plano para no anidar enlaces.

## Consecuencias

- Las tareas creadas por fuera de `TaskRepository` reciben número del trigger; RETURNING no lo ve, así que quien inserte por SQL debe releer la fila.
- Las referencias `#N` no se validan ni se guardan como aristas: son texto del intent que la UI resuelve al mostrarlo.
