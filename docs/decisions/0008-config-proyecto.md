# 0008 — Configuración de proyecto

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-05 · Código: `packages/schemas/src/project.ts`, `packages/domain/src/project-config.ts`, `packages/db/src/projects.ts`, `packages/server/src/api/projects.ts`

## Contexto

UW-01 dejó `agent_profiles` y `limits` como JSON libre (ADR 0005) y asignó su forma a UW-05. El diseño pide perfil de agente por fase (kind, modelo, args), límite de concurrencia por proyecto, timeout por fase con default de 30 minutos (`docs/design.md` §Concurrencia y §Timeout de fase) y que el perfil de verificación valide `kind = claude` (§Verificación con subagentes).

## Decisión

- **Perfiles.** `agentProfiles` tiene una clave por `Phase` (`refine`, `implement`, `verify`, `deliver`); cada perfil es `{ kind, model?, args }`. Una fase sin perfil se rellena con `{ kind: "claude", args: [] }`, así una fila antigua con `{}` sigue siendo válida. El default no trae los args del modo Auto ni el modelo Sonnet del approver (`docs/design.md` §Decisiones tomadas y §Verificación): se configuran en el perfil de cada proyecto, y UW-16 decide si el dispatcher exige o inyecta los args del modo Auto antes de despachar. Las fases y los campos desconocidos se rechazan.
- **Verify atado a claude.** El perfil de `verify` usa `z.literal("claude")` y no `AgentKind`: cuando v2 agregue otros kinds, la verificación seguirá exigiendo Claude Code hasta que otro agente tenga un equivalente a sus subagentes.
- **Límites.** `limits = { concurrency?, phaseTimeoutMinutes?, maxVerificationIterations? }`, enteros ≥ 1; el tope de iteraciones (de 1 a 20, default 3 con `DEFAULT_MAX_ITERATIONS`) lo agregó UW-23 ([ADR uw-23-verificacion](uw-23-verificacion.md)); el timeout tiene tope de una semana (`MAX_PHASE_TIMEOUT_MINUTES`), porque `setTimeout` trata más de 2^31‑1 ms como 1 ms. Sin `concurrency` solo aplica el límite global; una fase sin timeout usa `DEFAULT_PHASE_TIMEOUT_MINUTES` (30). El default se resuelve al leer (`phaseTimeoutMs`), no se guarda, para que cambiarlo no requiera migrar filas.
- **Campos.** `repo` es `owner/name` (lo que recibe `gh --repo`; el owner admite `_` por las cuentas EMU y el nombre no puede ser `.` ni `..`); `localPath` es absoluta y se normaliza (sin `//`, `.`, `..` ni `/` final, a mano porque schemas no importa `node:path`) para que la unicidad no se salte con variantes de la misma ruta; la raíz `/` se rechaza. No se comprueba en disco que exista ni que sea un repo git: eso es de quien lo usa (worktrees, `lunasq doctor`). `testCommand` y `bootstrap` son comandos opcionales.
- **PATCH.** Cada campo presente reemplaza al guardado, salvo `agentProfiles`, que se mezcla por fase: enviar solo `verify` conserva las demás. `null` borra `testCommand` o `bootstrap`. El update corre en una transacción y valida la fila resultante; si no es válida se revierte, y un PATCH puede corregir la fase inválida de una fila.
- **Lectura sin base.** El dominio define el puerto `ProjectConfigReader` (`get`, `list`) y las funciones `phaseProfile` y `phaseTimeoutMs`. Dispatcher, gate de tests y hooks dependen del puerto; `ProjectRepository` (db) lo implementa e `InMemoryProjectConfigReader` sirve en tests. Una suite de contrato (`@lunasq/domain/testing`) corre contra ambos. Los readers devuelven copias.
- **Validación en las dos direcciones.** El repositorio parsea con Zod lo que escribe y lo que lee; una fila con JSON inválido da `invalid_row` en vez de un objeto a medias. `list` también falla si alguna fila es inválida: nadie despacha con una lista parcial.
- **Errores HTTP.** 400 `invalid_json` o `invalid_input` (con los issues de Zod), 404 `not_found`, 409 `conflict` (con `field`: `name` o `localPath`) o `has_tasks` al borrar un proyecto con tareas, y 500 en JSON (`invalid_row` o `internal`) para lo demás vía `app.onError`. `ON DELETE RESTRICT` falla en SQLite con `SQLITE_CONSTRAINT_TRIGGER`, así que se detecta por el mensaje `FOREIGN KEY`.

## Consecuencias

- `hono` entra como dependencia de `server` (ya estaba en `docs/tech-stack.md`). No se usa `@hono/zod-validator`: `safeParse` a mano basta.
- `@lunasq/db` exporta `./test-helpers` y `@lunasq/domain` exporta `./testing` para que otros paquetes reutilicen fixtures y contrato; ambos declaran `vitest` como devDependency.
- `docs/design.md` dice que el id del workspace de herdr se guarda en Project; esa columna no existe y queda para UW-16.
