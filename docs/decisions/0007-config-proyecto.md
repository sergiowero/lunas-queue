# 0007 — Configuración de proyecto

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-05 · Código: `packages/schemas/src/project.ts`, `packages/domain/src/project-config.ts`, `packages/db/src/projects.ts`, `packages/server/src/api/projects.ts`

## Contexto

UW-01 dejó `agent_profiles` y `limits` como JSON libre (ADR 0005) y asignó su forma a UW-05. El diseño pide perfil de agente por fase (kind, modelo, args), límite de concurrencia por proyecto, timeout por fase con default de 30 minutos (`docs/design.md` §Concurrencia y §Timeout de fase) y que el perfil de verificación valide `kind = claude` (§Verificación con subagentes).

## Decisión

- **Perfiles.** `agentProfiles` tiene una clave por `Phase` (`refine`, `implement`, `verify`, `deliver`); cada perfil es `{ kind, model?, args }`. Una fase sin perfil se rellena con `{ kind: "claude", args: [] }`, así un proyecto nuevo se despacha sin configurar nada y una fila antigua con `{}` sigue siendo válida. Las fases y los campos desconocidos se rechazan.
- **Verify atado a claude.** El perfil de `verify` usa `z.literal("claude")` y no `AgentKind`: cuando v2 agregue otros kinds, la verificación seguirá exigiendo Claude Code hasta que otro agente tenga un equivalente a sus subagentes.
- **Límites.** `limits = { concurrency?, phaseTimeoutMinutes? }`, enteros ≥ 1. Sin `concurrency` solo aplica el límite global; una fase sin timeout usa `DEFAULT_PHASE_TIMEOUT_MINUTES` (30). El default se resuelve al leer (`phaseTimeoutMs`), no se guarda, para que cambiarlo no requiera migrar filas.
- **Campos.** `repo` es `owner/name` (lo que recibe `gh --repo`); `localPath` es absoluta. No se comprueba en disco que exista ni que sea un repo git: eso es de quien lo usa (worktrees, `lunasq doctor`). `testCommand` y `bootstrap` son comandos opcionales.
- **PATCH.** Cada campo presente reemplaza al guardado, incluido `agentProfiles` completo (las fases omitidas vuelven al default); `null` borra `testCommand` o `bootstrap`.
- **Lectura sin base.** El dominio define el puerto `ProjectConfigReader` (`get`, `list`) y las funciones `phaseProfile` y `phaseTimeoutMs`. Dispatcher, gate de tests y hooks dependen del puerto; `ProjectRepository` (db) lo implementa e `InMemoryProjectConfigReader` sirve en tests. Una suite de contrato (`@lunasq/domain/testing`) corre contra ambos. Los readers devuelven copias.
- **Validación en las dos direcciones.** El repositorio parsea con Zod lo que escribe y lo que lee; una fila con JSON inválido da `invalid_row` en vez de un objeto a medias.
- **Errores HTTP.** 400 `invalid_json` o `invalid_input` (con los issues de Zod), 404 `not_found`, 409 `conflict` (con `field`: `name` o `localPath`) o `has_tasks` al borrar un proyecto con tareas. `ON DELETE RESTRICT` falla en SQLite con `SQLITE_CONSTRAINT_TRIGGER`, así que se detecta por el mensaje `FOREIGN KEY`.

## Consecuencias

- `hono` entra como dependencia de `server` (ya estaba en `docs/tech-stack.md`). No se usa `@hono/zod-validator`: `safeParse` a mano basta.
- `@lunasq/db` exporta `./test-helpers` y `@lunasq/domain` exporta `./testing` para que otros paquetes reutilicen fixtures y contrato.
- `docs/design.md` dice que el id del workspace de herdr se guarda en Project; esa columna no existe y queda para UW-16.
