# 0005 — Convenciones del esquema SQLite

- Estado: aceptada
- Fecha: 2026-10-28
- Unidad: UW-01 · Código: `packages/db/src/schema.ts`, `packages/db/drizzle/`, `packages/schemas/src/enums.ts`

## Contexto

UW-01 crea las nueve tablas del modelo de dominio (`docs/design.md`, Modelo de dominio y Consumo). Varias decisiones de forma no estaban escritas y las siguientes unidades (UW-04, UW-05, UW-07, UW-08, UW-12, UW-15, UW-20) las heredan.

## Decisión

- **Ids.** Texto con UUID v4 (`crypto.randomUUID()`) generado en la aplicación. `events` y `outbox` usan entero autoincremental: dan un orden total que el Event log y el publicador necesitan. El id UUID no tiene default en SQL: una escritura fuera de Drizzle debe generarlo.
- **Tiempos.** Enteros en milisegundos epoch (`timestamp_ms` en Drizzle). El default vive en SQL (`unixepoch('subsec') * 1000`), así también aplica a escrituras fuera de Drizzle; `updated_at` se renueva solo desde Drizzle al actualizar; un `UPDATE` en SQL crudo lo deja igual.
- **Enums.** Los valores se definen una sola vez con Zod en `@lunasq/schemas` (`TaskState`, `SubState`, `Phase`, etc.). `db` los usa para el tipo de la columna y para un `CHECK … IN (…)` por columna, porque Drizzle no genera esos CHECK solo. Agregar un valor implica una migración.
- **Prioridad.** `CHECK (typeof(priority) = 'integer' AND priority BETWEEN 0 AND 9007199254740991)`: entero sin signo hasta `Number.MAX_SAFE_INTEGER`, porque la columna se lee como `number`. Sin `typeof`, SQLite aceptaría reales. Los contadores (tokens, iteraciones, intentos del outbox) usan el mismo CHECK sin tope.
- **JSON.** Columnas de texto en modo JSON de Drizzle, con defaults en SQL (`'{}'`, `'[]'`). Su forma la validan las unidades dueñas (perfil y límites de proyecto en UW-05, spec en UW-12, handoff en UW-03).
- **Sub‑estado.** Nullable: solo los estados con agente lo tienen (default `queued` al nacer en Draft). La base no ata `sub_state` a `state`; esa coherencia es de la máquina de estados (UW-04).
- **Borrado.** Un proyecto con tareas no se puede borrar (`restrict`). El Event log es append‑only: una tarea con eventos tampoco se puede borrar (`restrict`), así que en la práctica las tareas se cancelan, no se borran. Si una tarea sin eventos se borra, arrastra en cascada sus aristas, specs, runs, questions y usage; `caused_by` y `questions.run_id` quedan en NULL si su referencia desaparece.
- **Run activo.** Índice único parcial `runs(task_id) WHERE ended_at IS NULL`: a lo sumo un Run abierto por tarea, así un despacho duplicado falla en la base. Cerrar un Run es poner `ended_at`. Cada Run guarda `model` e `iteration` (la iteración de verificación de la tarea al despachar) para separar rework de reintentos en la auditoría y en el consumo.
- **Consumo idempotente.** `usage_records.source_ref` (id de mensaje o request en la fuente) es único por `(run_id, source, source_ref)`; reingestar el mismo lote no duplica tokens. Sin `source_ref` no se deduplica.
- **Spec aprobada.** La base no impide dos versiones aprobadas de una misma tarea; esa regla y su índice, si hacen falta, son de UW-12.
- **Migraciones.** drizzle-kit genera el SQL y los snapshots en `packages/db/drizzle/` (`pnpm --filter @lunasq/db db:generate`). Un test regenera contra el esquema en un directorio temporal y falla si hay cambios sin migración.
- **Instalación sin build scripts.** Además de `better-sqlite3` (ADR 0003), `allowBuilds` declara `esbuild: false`: lo trae drizzle-kit y resuelve su binario desde el paquete `@esbuild/<plataforma>` sin postinstall.
- **Biome.** Ignora `pnpm-lock.yaml` y `packages/db/drizzle/`: son generados y sus herramientas los reescriben en su propio formato.

## Consecuencias

- Las unidades siguientes importan tablas y `openDatabase`/`migrateDatabase` desde `@lunasq/db`, y los enums desde `@lunasq/schemas`.
- Un cambio de esquema siempre va con su migración generada; el test de sincronía lo hace cumplir en CI.
