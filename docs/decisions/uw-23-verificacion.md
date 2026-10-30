# UW-23 — Fase de verificación: evidencia de revisores, tope, riesgo, rework y hooks de fase

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-23 · Código: `packages/domain/src/verdict.ts`, `phaseProfile` y `maxVerificationIterations` en `packages/domain/src/project-config.ts`, `recordVerdict` y `latestHandoff` en `packages/db/src/runs.ts`, `VerdictRecordedPayload` y `TaskContext.rework` en `packages/schemas/src/mcp.ts`, `PhaseHooks` en `packages/server/src/mcp/ports.ts`, `submitForVerification` y `submitVerdict` en `packages/server/src/mcp/service.ts`

## Contexto

`docs/design.md` (§Verificación con subagentes y §Loop implementación ↔ verificación) define la fase: un approver en Sonnet que lanza 4 revisores y emite pass o reject. El veredicto se rechaza si reporta un revisor que no aparece en los hooks. Un reject vuelve a implementación solo con los must-fix, el loop tiene un tope de 3 iteraciones configurable y la etiqueta de riesgo llega al PR.

Las unidades anteriores dejaron casi todas las piezas:

- UW-03: el esquema del veredicto.
- UW-04: `verdict_rework` con su tope.
- UW-11: el gate antes del pass.
- UW-15: `submit_verdict`.
- UW-19: `run_subagents`.

ADR uw-10-hooks deja a UW-23 los puntos `after_implementation`, `before_verification` y `after_verification`. ADR uw-11-gate-tests advierte que un hook que commitea antes de verificar invalida el pass si el gate no vuelve a correr. El criterio de UW-23: un caso pass y uno reject recorren el loop, y la cuarta iteración termina en Needs human.

## Decisión

- **Evidencia de revisores** (`checkReviewerEvidence`, domain). Compara el veredicto con `RunSubagentRepository.forRun(runId)` por `agentType`. Cuentan solo los registros del Run del approver. Reglas:
  - Un revisor `ran` necesita al menos una ejecución con `SubagentStop`. Sin registros, el error dice «no aparece en los hooks»; con `SubagentStart` sin `SubagentStop`, «no terminó». Si se relanzó, basta una ejecución terminada.
  - Un revisor `skipped` no puede tener una ejecución terminada, porque el approver estaría descartando un reporte. Uno que empezó y no terminó (se cayó) puede omitirse con justificación.
  - Un must-fix o un refutado no puede tener como `source` a un revisor omitido.
  - Los subagentes que no son revisores (p. ej. `Explore`) se ignoran.
  - El error es `reviewer_evidence_mismatch` con issues por ruta, sin efectos: el Run sigue abierto para corregir.
  - La comprobación corre antes del gate del pass. Si el Run ya registró un veredicto, no se repite: decide la transacción (idempotente o `verdict_already_recorded`).
- **Approver en Sonnet.** `phaseProfile(config, "verify")` devuelve `model: "sonnet"` (`DEFAULT_VERIFY_MODEL`) si el perfil no fija modelo. El valor se resuelve al leer, como el timeout de fase (ADR 0008): llega a `--model` y a `runs.model` sin migrar proyectos. Un modelo explícito en el perfil manda.
- **Tope configurable.** `limits.maxVerificationIterations` (entero de 1 a 20, opcional; default `DEFAULT_MAX_ITERATIONS`, 3) llega como `maxIterations` a `verdict_rework`. La semántica de ADR 0007 no cambia:
  - Con el default caben tres reworks.
  - Los rejects de las verificaciones 1 a 3 vuelven a implementación.
  - El reject de la cuarta lleva la tarea a `needs_human` con `iterations_exhausted`.
- **Riesgo y evento.** En la transacción que guarda el veredicto (pass o reject), `recordVerdict`:
  - fija `tasks.risk_label`;
  - agrega `verification.verdict_recorded` (actor `agent`, publicado en el outbox) con Run, veredicto, iteración del Run, riesgo, cantidad de must-fix y de refutados, y revisores omitidos.

  El handoff completo, con los refutados y sus motivos, sigue en el Run. Con pass, ese evento es el disparo de la entrega (UW-26), porque `verdict_pass` no se emite hasta crear el PR (ADR uw-15-mcp-tools). En un reject, la etiqueta queda como la última evaluación del approver; el siguiente veredicto la reemplaza.
- **Rework solo con los must-fix.** `TaskContext.rework` (`{runId, iteration, mustFix} | null`) llega en implementación cuando el último veredicto guardado de la tarea es un reject. `verificationHistory` va vacío en implementación y completo en verificación: el implementador no ve reportes por revisor ni refutados. Si el último veredicto es un pass (p. ej. al volver por un conflicto en la entrega), `rework` es null.
- **Hooks de fase** por el puerto `PhaseHooks`, que `HookService` cumple. `createApp` recibe `phaseHooks`; sin él usa `NoPhaseHooks`, que pasa sin correr nada, como un proyecto sin `lunasq/hooks/`.
  - **`after_implementation` y `before_verification` corren dentro de `submit_for_verification`**, en ese orden, después de comprobar worktree limpio y commits, y antes del gate. Así el gate prueba el HEAD que incluye lo que commitearon los hooks, el `headSha` que compara el pass ya lo incluye y el verificador se despacha cuando terminaron. El diseño decía «después del gate»; se cambió para no correr la suite dos veces. Los dos llevan el Run del implementador; `before_verification` tiene `LUNASQ_PHASE=verify`, que fija `hookPointPhase`.
  - **`after_verification` corre dentro de `submit_verdict`**, después del gate del pass y antes de la transacción, con `LUNASQ_PHASE_RESULT` igual al veredicto. Correrlo después del reject se descartó: la tarea ya estaría en `in_progress/queued` y el scheduler podría despachar al implementador mientras el hook escribe en el worktree.
  - Un punto `blocked` responde `hook_blocked` con el script y el error. No se registra nada más: HookService ya escaló la tarea a `needs_human` con `hook_failed`. El Run queda abierto, como en los demás escalamientos (UW-17), y al reanudar empieza un Run nuevo de la misma fase.
  - Los hooks corren con el candado `gate_in_progress` del Run, así un reintento concurrente no los lanza dos veces. Un reintento después de un rechazo sí los vuelve a correr, por eso deben ser idempotentes (ADR uw-10-hooks).

## Consecuencias

- `submit_for_verification` y `submit_verdict` pueden tardar lo que tarden los hooks más el gate. El `MCP_TOOL_TIMEOUT` que fija UW-16 debe cubrir ambos. Si un proyecto tiene hooks largos, conviene moverlos a `before_delivery` o subir ese timeout.
- Un commit de `after_verification` con pass entra al branch después del gate de `verdict_pass`. Lo cubre el gate final de la entrega (UW-26), que corre después del rebase.
- **UW-26** se suscribe a `verification.verdict_recorded` con `verdict: pass` para arrancar la entrega y lee la etiqueta de riesgo de `tasks.risk_label` o del handoff.
- **UW-18**: la skill `verify-task` debe reportar como `ran` todo revisor que lanzó y terminó, también uno cuyo reporte descartó. `reviewer_evidence_mismatch` se corrige en el mismo Run. La skill `implement-task` lee `rework.mustFix`.
- **UW-29** compone `HookService` como `phaseHooks` en `createApp`.
- `before_implementation` (al despachar) y `on_failure` siguen pendientes; ADR uw-16-dispatcher los deja abiertos.
