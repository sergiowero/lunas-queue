# PR en conflicto después de la entrega y selección de revisores

- Estado: aceptada
- Fecha: 2026-10-30
- Código: `delivery_conflict` en `packages/domain/src/state-machine.ts`, `PrTrackingStore.recordPrConflict` (`packages/domain/src/pull-requests.ts`, `packages/db/src/task-prs.ts`), `PullRequest.mergeable` en `packages/adapters/src/github/`, `PrPoller` en `packages/server/src/github/poller.ts`, `DeliveryConflictReason` en `packages/schemas/src/delivery.ts`, `assets/skills/verify-task/SKILL.md`, `assets/agents/lunasq/`

## Contexto

La entrega (ADR uw-26-entrega) rebasa sobre la base antes de abrir el PR, pero después la tarea queda en Completed y nadie vuelve a mirar el branch. Con varias tareas en paralelo, mergear un PR deja a los demás en conflicto con la base, y LunasQ no lo detectaba: el humano tenía que resolverlos a mano.

Aparte, la skill `verify-task` y las descripciones de los revisores decían «lanza los 4 revisores» y «lánzalo en toda verificación», así que el approver lanzaba casi siempre los cuatro, aunque el diseño dice que decide cuáles aplican.

## Decisión

- **Detección.** `GitHubAdapter.getPr` lee `mergeable` de `gh pr view` (`mergeable`, `conflicting` o `unknown` mientras GitHub lo calcula). El poller de merges, en la misma pasada, llama `recordPrConflict` por cada PR abierto en `conflicting`. No se rebasa ni se hace push desde el poller: GitHub solo marca `conflicting` cuando hay conflicto real, que pide criterio del implementador.
- **Transición.** `delivery_conflict` aplica también desde `completed`, solo por el sistema; es la única salida de completed. La tarea va a `in_progress/queued` sin subir la iteración, igual que un conflicto en la entrega. `isTerminal("completed")` no cambia: mientras está en completed nada más la mueve.
- **Registro.** `recordPrConflict` corre en una transacción IMMEDIATE: solo actúa si la tarea está en completed y el PR observado es su PR abierto. Aplica la transición y agrega `delivery.conflict` con `reason: pr_conflict`, el Run del último verificador, `files: []` (GitHub no los informa) y `output: null`. Repetirlo mientras el PR sigue en conflicto no hace nada, porque la tarea ya no está en completed.
- **Ciclo.** El implementador recibe `deliveryConflict` (la skill `implement-task` explica `pr_conflict`), integra la base y entrega. La verificación y la entrega se repiten; `createPr` devuelve el PR abierto y `recordPrOpened` del mismo PR no escribe nada. El push usa `--force-with-lease`, así que el PR se actualiza.
- **Tope.** El conteo de conflictos de la entrega empieza de cero en el último `resume` o `verdict_pass`: un PR que queda en conflicto semanas después no hereda los conflictos de su primera entrega.
- **Revisores.** `verify-task` pide elegir cada revisor por separado con una tabla de cuándo lanzarlo y cuándo omitirlo (seguridad solo si el diff toca una frontera de confianza; UX si cambia un flujo o sus estados; UI si cambia algo visible; código si cambia código o tests), y que la justificación de un omitido cite el diff. Aclara que reportar los 4 en el handoff no es lanzar los 4. Las descripciones de los subagentes dicen cuándo lanzarlos. La evidencia por hooks (ADR uw-23-verificacion) no cambia.

## Consecuencias

- Un PR en conflicto vuelve a gastar una implementación y una verificación; es lo que antes hacía el humano a mano.
- La detección depende del intervalo del poller (60 s por defecto) y de que GitHub haya calculado `mergeable`; un `unknown` se resuelve en la pasada siguiente.
- Los revisores y skills instalados en `~/.claude/` se actualizan con `lunasq install`.
