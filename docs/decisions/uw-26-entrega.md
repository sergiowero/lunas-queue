# UW-26 — Fase de entrega: rebase, trailers, suite final, push y PR dentro del Run del verificador

- Estado: aceptada
- Fecha: 2026-10-30
- Unidad: UW-26 · Código: `packages/server/src/delivery/`, `packages/domain/src/delivery.ts`, `packages/schemas/src/delivery.ts`, `rebase`, `listCommits`, `addTrailers` y `push` en `packages/adapters/src/git/`, `addLabels` en `packages/adapters/src/github/`, `deliveryConflict` en `TaskContext` (`packages/schemas/src/mcp.ts`), `prUrl` en `PhaseHookInput`, composición en `packages/server/src/runtime/runtime.ts`

## Contexto

`docs/design.md` (§Entrega) y ADR 0007 fijan que la entrega no tiene agente: la hace LunasQ mientras el Run del verificador sigue abierto, y `verdict_pass` solo se emite cuando el PR existe. ADR uw-23-verificacion deja el disparo: el evento `verification.verdict_recorded` con `verdict: pass`. ADR uw-24-archivo-evidencia exige que el Run del verificador esté cerrado y su sección escrita antes del commit de evidencia y del push. ADR uw-11-gate-tests reserva el disparo `delivery` del gate, y ADR uw-14-adapter-github pide registrar el PR con `recordPrOpened` antes de `verdict_pass`.

El criterio de UW-26: una tarea con pass termina en un PR con trailers y etiqueta de riesgo.

## Decisión

- **Disparo y reintentos.** `subscribeDelivery` escucha `verification.verdict_recorded` con pass en el outbox y llama `DeliveryService.deliver(taskId)` sin esperarlo (la suite y los hooks pueden tardar minutos). `deliver` es idempotente y corre con un candado por tarea: ignora una tarea que ya no está en `verification/running` (`not_delivering`) o sin pass guardado (`no_pass_verdict`), y retoma una entrega a medias. `recover()` recorre al arrancar las tareas en `verification/running` con un pass guardado, porque el outbox ya marcó el mensaje como entregado.
- **Orden de la entrega**:
  1. Hook `before_delivery` (con el Run del verificador).
  2. `fetch` de la base y rebase sobre `origin/<base>`.
  3. Trailers `LunasQ-Task` y `LunasQ-Run` en cada commit de `origin/<base>..HEAD`.
  4. Suite final con `PaneTestGate` y disparo `delivery`.
  5. Cierre del Run del verificador (`PhaseDispatcher.closeRun`, que cierra el pane y escribe la sección de evidencia) y `EvidenceService.commit`.
  6. Push.
  7. PR (`createPr`, idempotente) y etiqueta de riesgo.
  8. `recordPrOpened`.
  9. Hook `after_delivery` con la URL del PR y, si commiteó, un segundo push.
  10. `verdict_pass`.

  El Run se cierra antes del push y no después de la transición, como sugería ADR 0007: sin eso la sección del verificador no podría viajar en el PR. No rompe nada: el scheduler solo despacha `queued`, el reconciliador solo mira Runs abiertos, y una entrega retomada no vuelve a cerrar un Run cerrado. El Run se cierra con `success`; el motivo de un escalamiento va como `cancelled` con `failure_reason`, que no cuenta como fallo para los reintentos.
- **Trailers por commit.** Los commits los escribe el agente, y nadie les puso trailers. `commitTrailers` (dominio) asigna a cada commit la tarea y el Run de implementación vivo cuando se escribió (por la fecha del autor, que el rebase no cambia); un commit anterior a todo Run usa el primero, y sin Runs de implementación, el del verificador. `GitAdapter.addTrailers` reescribe los commits con `commit-tree` (mismo árbol, mismo autor y fecha), sin editor ni hooks de git, y no repite una clave que el commit ya trae: los commits de los hooks (`HookService`) conservan los suyos y repetir la entrega no cambia nada. El PR lleva `LunasQ-Task` y `LunasQ-Run` (del verificador) al final de su descripción.
- **Adapter de git.** `rebase` (devuelve `up_to_date`, `rebased` o `conflict` con los archivos; un conflicto se aborta, así el worktree queda como estaba, y cualquier otro fallo lanza `git_failed`), `listCommits`, `addTrailers` y `push` (`HEAD:refs/heads/<branch>` con `--force-with-lease`: tras el rebase la historia cambia, pero no pisa un push ajeno). Real y fake cumplen la misma suite de contrato. El fake detecta conflictos por rutas tocadas en ambos lados y, al rebasar, rehace cada commit propio sobre la base nueva con las mismas rutas.
- **Conflicto o suite en rojo.** La tarea vuelve a `in_progress` con `delivery_conflict` (sin subir la iteración, ADR 0007) en la misma transacción que el evento `delivery.conflict` (`rebase_conflict` con los archivos, o `tests_failed` con la cola de la salida). `TaskContext.deliveryConflict` se lo entrega al implementador mientras no haya un veredicto posterior; la skill `implement-task` le indica integrar la base y corregir. Como esos regresos no suben la iteración, el ciclo tiene su propio tope: con tantos conflictos desde el último `resume` como `limits.maxVerificationIterations`, la entrega escala. Un proyecto sin `testCommand` no tiene gate en verde y tampoco entrega.
- **Escalamientos.** Un hook `block` detiene la entrega (`blocked`); si `HookService` no escaló la tarea, la entrega la escala con `hook_failed`. Un fallo de push, de `gh`, de la transición o de cualquier paso escala con la razón nueva `delivery_failed` (`EscalationReason`), con el error como nota, y cierra el Run si seguía abierto. Al reanudar, la tarea vuelve a `verification/queued` y se verifica de nuevo; la nueva entrega encuentra el PR abierto y lo reutiliza.
- **PR.** Título: primera línea del intent, de hasta 72 caracteres. Cuerpo (`prBody`, dominio): intent, criterios con su veredicto y evidencia, riesgo, revisores (o la justificación de los omitidos), hallazgos refutados, ruta del archivo de evidencia y trailers; se recorta a 60 000 caracteres. Etiqueta de GitHub `lunasq:risk-low|medium|high`: `GitHubAdapter.addLabels` la crea si el repo no la tiene (`gh label create --force`) y la pone con `gh pr edit`. Si poner la etiqueta falla, el PR sigue siendo válido y la entrega continúa; el riesgo queda también en el cuerpo. `PullRequest.labels` expone las etiquetas.
- **`verdict_pass`.** Los hechos salen de los handoffs (`deliveryFacts`): el veredicto es pass, todo criterio de la spec pasó y todo criterio tiene al menos un test en el último handoff de implementación. Va con `testGatePassed` (la suite final) y `prCreated`.
- **Composición.** `startRuntime` arma `EvidenceService` (pasado al `Orchestrator` y a la entrega) y `DeliveryService`, suscribe la entrega al outbox y llama `recover()` al arrancar sin frenar el arranque. `stop` desuscribe pero no espera a una entrega en curso: es idempotente y se retoma al arrancar.

## Consecuencias

- Si `after_delivery` modifica archivos, `HookService` los commitea y la entrega hace un segundo push, así que entran al PR (un push extra puede reiniciar el CI). Los cambios que no necesiten la URL del PR conviene hacerlos en `before_delivery`.
- Un push rechazado por `--force-with-lease` (alguien más escribió en `lunasq/<id>`) escala la tarea en lugar de pisar ese trabajo.
- Un PR que un humano cerró sin merge y una entrega posterior abren otro PR (`createPr` no cuenta los cerrados) y `recordPrOpened` lo acepta porque el estado previo es `closed`.
- La suite final corre con el `testCommand` del proyecto, igual que los demás gates.
- El Run del verificador se cierra antes de que exista el PR. Si el proceso cae entre el cierre y `verdict_pass`, la sección ya está escrita y `recover()` completa la entrega.
- UW-29 (piloto) debe probar la entrega contra `git` y `gh` reales: aquí solo el contrato del adapter de git corre contra git real; `addLabels` contra GitHub necesita `LUNASQ_GH_SANDBOX_REPO` (`pnpm --filter @lunasq/adapters test:gh`).
