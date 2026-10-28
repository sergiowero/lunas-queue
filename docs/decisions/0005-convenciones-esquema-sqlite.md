# 0005 — Convenciones del esquema SQLite

- Estado: aceptada
- Fecha: 2026-10-28
- Unidad: UW-01 · Código: `packages/db/src/schema.ts`, `packages/db/drizzle/`, `packages/schemas/src/enums.ts`

## Contexto

UW-01 crea las nueve tablas del modelo de dominio (`docs/design.md`, Modelo de dominio y Consumo). Varias decisiones de forma no estaban escritas y las siguientes unidades (UW-04, UW-05, UW-07, UW-08, UW-12, UW-15, UW-20) las heredan.

## Decisión

- **Ids.** Texto con UUID v4 (`crypto.randomUUID()`) generado en la aplicación. `events` y `outbox` usan entero autoincremental: dan un orden total que el Event log y el publicador necesitan.
- **Tiempos.** Enteros en milisegundos epoch (`timestamp_ms` en Drizzle). El default vive en SQL (`unixepoch('subsec') * 1000`), así también aplica a escrituras fuera de Drizzle; `updated_at` se renueva desde Drizzle al actualizar.
- **Enums.** Los valores se definen una sola vez con Zod en `@lunasq/schemas` (`TaskState`, `SubState`, `Phase`, etc.). `db` los usa para el tipo de la columna y para un `CHECK … IN (…)` por columna, porque Drizzle no genera esos CHECK solo. Agregar un valor implica una migración.
- **Prioridad.** `CHECK (typeof(priority) = 'integer' AND priority >= 0)`: entero sin signo de 64 bits en la práctica. Sin `typeof`, SQLite aceptaría reales.
- **JSON.** Columnas de texto en modo JSON de Drizzle, con defaults en SQL (`'{}'`, `'[]'`). Su forma la validan las unidades dueñas (perfil y límites de proyecto en UW-05, spec en UW-12, handoff en UW-03).
- **Sub‑estado.** Nullable: solo los estados con agente lo tienen (default `queued` al nacer en Draft).
- **Borrado.** Un proyecto con tareas no se puede borrar (`restrict`). Borrar una tarea arrastra en cascada sus aristas, specs, runs, questions, usage, eventos y outbox; `caused_by` y `questions.run_id` quedan en NULL si su referencia desaparece. El flujo normal es cancelar, no borrar; si UW-04 decide que el Event log debe sobrevivir al borrado de la tarea, cambia la regla de `events` en su propia migración.
- **Migraciones.** drizzle-kit genera el SQL y los snapshots en `packages/db/drizzle/` (`pnpm --filter @lunasq/db db:generate`). Un test regenera contra el esquema en un directorio temporal y falla si hay cambios sin migración.
- **Instalación sin build scripts.** Además de `better-sqlite3` (ADR 0003), `allowBuilds` declara `esbuild: false`: lo trae drizzle-kit y resuelve su binario desde el paquete `@esbuild/<plataforma>` sin postinstall.
- **Biome.** Ignora `pnpm-lock.yaml` y `packages/db/drizzle/`: son generados y sus herramientas los reescriben en su propio formato.

## Consecuencias

- Las unidades siguientes importan tablas y `openDatabase`/`migrateDatabase` desde `@lunasq/db`, y los enums desde `@lunasq/schemas`.
- Un cambio de esquema siempre va con su migración generada; el test de sincronía lo hace cumplir en CI.
