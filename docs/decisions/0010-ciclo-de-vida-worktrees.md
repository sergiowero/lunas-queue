# 0010 — Ciclo de vida de worktrees: branch determinístico, bootstrap antes de persistir y huérfanos

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-09 · Código: `packages/domain/src/worktrees.ts`, `packages/db/src/task-worktrees.ts`, `packages/adapters/src/process/`, `listWorktrees` en `packages/adapters/src/herdr/`, `packages/server/src/worktrees/`

## Contexto

`docs/design.md` (§Ciclo de vida del worktree) fija una tarea = un worktree = un branch desde el primer despacho hasta el merge: crear desde la rama base, correr el bootstrap, reabrir en fases siguientes, remover tras el merge o la cancelación y detectar huérfanos. ADR 0004 dejó claro que `worktree create` no es idempotente. El criterio de UW-09: dos tareas del mismo repo trabajan en paralelo y repetir la operación no duplica nada.

## Decisión

- **Branch.** `lunasq/<taskId>` (`taskBranch` en domain). El id debe ser un solo segmento seguro para git (los UUID lo son); `taskIdFromBranch` lo invierte. Solo los branches con ese prefijo se consideran de LunasQ. La ruta del checkout la elige herdr (`~/.herdr/worktrees/<repo>/<slug>`) y se guarda la que devuelve.
- **Rama base remota al crear.** Antes de `worktree create` se corre `git fetch --quiet origin <baseBranch>` en el checkout del proyecto y el worktree sale de `origin/<baseBranch>`. Así una tarea dependiente parte de una base que ya incluye el merge de sus dependencias aunque el `main` local esté atrasado (comprobado con herdr 0.9.5). Si el fetch falla, `base_fetch_failed` y no se crea nada. Al reabrir no se hace fetch.
- **La BD dice si el worktree está listo.** `ensure` asegura el workspace del proyecto, hace `ensureWorktree` y corre el bootstrap si el checkout se acaba de crear o si `worktree_path` en la BD no coincide con la ruta. Solo después guarda `branch` y `worktree_path`. Un bootstrap que falla (exit ≠ 0 o timeout, 30 min por defecto) da `bootstrap_failed` y deja la ruta en null, así el siguiente `ensure` lo reintenta: **el bootstrap del proyecto debe ser idempotente**. Corre con `sh -c` en el worktree y recibe `LUNASQ_PROJECT_ID`, `LUNASQ_TASK_ID`, `LUNASQ_BRANCH`, `LUNASQ_BASE_BRANCH` y `LUNASQ_WORKTREE`.
- **Bootstrap como proceso hijo, no en un pane.** Se ejecuta con el nuevo `ProcessRunner` de `adapters` (`ShellProcessRunner`, con su fake): tiene que terminar antes de persistir y antes de que arranque el agente, y su resultado decide el `ensure`. No se usa el evento `worktree.created` de herdr. El runner corre en su propio grupo de procesos (el timeout mata también a los hijos), no lanza por exit code y conserva los últimos 256 KiB de cada stream. UW-10 y UW-11 pueden reusarlo o seguir con el pane de herdr de `docs/tech-stack.md`.
- **Serialización por tarea.** `ensure`, `remove` y la limpieza de huérfanos toman un lock en proceso por task id (`KeyedLock`): dos `ensure` concurrentes de la misma tarea no hacen dos `create`; tareas distintas corren en paralelo. Basta con un solo dispatcher en v1 (`docs/tech-stack.md`).
- **Tareas que ya liberaron su worktree.** `worktreeReleased`: `cancelled`, o `completed` con `prState = merged`. `completed` llega al abrir el PR y la tarea puede volver a in progress, así que con el PR abierto, cerrado sin merge o sin PR el worktree se conserva. `ensure` rechaza una tarea liberada con `task_released`.
- **Remover.** `remove` busca el branch en `worktree list`; si el worktree está cerrado lo reabre (herdr necesita su workspace) y hace `worktree remove`, que conserva el branch. Luego pone `worktree_path` en null. Sin worktree es un no-op (`removed: false`). Con cambios sin commit herdr responde `dirty_worktree_requires_force` y el servicio lo traduce a `dirty_worktree`. Solo se borra con `force`.
- **Huérfanos.** `findOrphans` cruza `worktree list` con las tareas del proyecto: es huérfano un worktree `lunasq/*` cuya tarea no existe (`task_not_found`) o que ya liberó su worktree (`task_released`). Los branches ajenos y los checkouts en HEAD detached nunca se tocan. `cleanupOrphans` los remueve sin forzar, revalida cada tarea bajo su lock y reporta los fallos (p. ej. `dirty_worktree`) sin detenerse. Disparar la remoción tras el merge o la cancelación, y la limpieza periódica, quedan para quien consume el servicio (UW-17, UW-26).
- **Adapter de herdr.** `listWorktrees(workspaceId)` devuelve los worktrees enlazados del repo (`worktree list` sin el checkout principal), abiertos o no; uno removido ya no aparece aunque su branch siga. La suite de contrato lo cubre contra el fake y contra herdr real. El fake modela `dirty_worktree_requires_force` con `setWorktreeDirty(path)`.

## Consecuencias

- El workspace del proyecto se busca por label (`ensureWorkspace` con el nombre del proyecto), porque Project todavía no guarda su id de herdr (ADR 0008, queda para UW-16).
- Un worktree creado desde `origin/<base>` queda con upstream `origin/<base>`: la entrega (UW-26) debe hacer push con refspec explícito (`git push -u origin lunasq/<id>`).
- `findOrphans` y `cleanupOrphans` crean el workspace del proyecto en herdr si no existe, como el resto de operaciones.
- El branch de una tarea removida queda en el repo local; borrarlo no es parte de v1.
