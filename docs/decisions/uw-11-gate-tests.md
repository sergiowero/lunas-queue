# UW-11 — Gate de tests en un pane de herdr, con su resultado en el Event log

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-11 · Código: `packages/server/src/test-gate/`, `packages/schemas/src/test-gate.ts`, `envAllowlist` en `packages/adapters/src/process/`, `submitVerdict` en `packages/server/src/mcp/service.ts`

## Contexto

`docs/design.md` (§Prácticas de ingeniería) pide que LunasQ corra el comando de tests del proyecto en el worktree al recibir `submit_for_verification` y otra vez antes de aceptar un pass, sin confiar en lo que reporte el agente. `docs/tech-stack.md` pide que corra en un pane de herdr con un wrapper que registra exit code y salida. UW-15 dejó el puerto `TestGate` con `ShellTestGate`, que corría el comando en el proceso de LunasQ, heredaba su entorno (con los tokens de `gh`), no guardaba nada y no corría antes del pass. El criterio de UW-11: una suite en rojo bloquea la transición aunque el agente diga lo contrario.

## Decisión

- **`PaneTestGate`** (server) cumple el puerto `TestGate`. Abre un pane desde la raíz del worktree (`WorktreeService.ensure(taskId).rootPaneId`) con `HerdrPaneRunner` (ADR uw-10-hooks), corre el comando en el worktree con timeout de 20 minutos (`DEFAULT_GATE_TIMEOUT_MS`) y cierra el pane. Pasa solo con exit 0 y sin timeout. Sin comando de tests, sin worktree o con herdr caído falla cerrado: no hay pass sin una suite en verde.
- **Entorno mínimo.** `ProcessInput.envAllowlist` (adapters): si viene, el comando corre con `env -i` y solo las variables de la lista que estén definidas, más las de `env`. Lo cumplen `ShellProcessRunner`, `HerdrPaneRunner` (el wrapper arma la lista en el shell del pane) y el fake. El gate usa `GATE_ENV_ALLOWLIST` (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `TMPDIR`) y agrega `CI=1`, `LUNASQ_TASK_ID` y `LUNASQ_RUN_ID`. `GH_TOKEN`, claves de API y el resto del entorno del servidor de herdr no llegan a la suite. `CI=1` evita modos watch e interactivos.
- **Registro.** Cada ejecución deja `test_gate.executed` (actor `system`, publicado en el outbox) con Run, disparo (`submit_for_verification`, `verdict_pass` o `delivery`), comando, sha del `HEAD` probado, exit code, timeout, duración, resultado, los últimos 16 KiB de la salida y el error si no corrió. El esquema exige que `passed` coincida con exit 0, sin timeout y sin error. Se registra también cuando falla cerrado. Sin tabla nueva, como `hook.executed`: el archivo de evidencia (UW-24) lee estos eventos.
- **Al agente** le llega la cola de la salida (4000 caracteres, `GATE_OUTPUT_LIMIT`) con `test_gate_failed`, más una línea con el motivo si hubo timeout o error.
- **Gate antes del pass.** `submit_verdict` pasa a ser async. Con un pass y sin veredicto registrado en el Run: worktree limpio (`dirty_worktree`; la prueba de reversión del verificador toca el código) → gate con `verdict_pass` → transacción. Un pass en rojo responde `test_gate_failed`, no guarda el handoff y deja el Run abierto: el verificador puede corregir a reject. Repetir un pass ya registrado no vuelve a correr la suite. Un reject no corre el gate. El candado `gate_in_progress` por Run vale para las dos tools.
- **`ShellTestGate` se retira.** `createApp` recibe el gate de quien compone el servidor; sin él usa `UnavailableTestGate`, que nunca pasa.

## Consecuencias

- Una suite que necesita otras variables (`DATABASE_URL`, `NODE_OPTIONS`) falla en el gate. El proyecto las fija en su comando de tests o en un script del repo. Si se repite, una allowlist por proyecto en la config (ADR 0008) queda para después.
- `submit_verdict` con pass también puede tardar hasta el timeout del gate. El `MCP_TOOL_TIMEOUT` que fija UW-16 en el pane aplica en todas las fases, así que lo cubre.
- UW-18 debe indicar en la skill de verificación que el worktree quede limpio (revertir la prueba de reversión) antes del pass, y que `test_gate_failed` en un pass pide un reject o corregir el entorno.
- UW-26 corre el gate final tras el rebase con el mismo `PaneTestGate` y el disparo `delivery`.
- La composición del servidor (UW-29) arma `PaneTestGate` con `RealGit`, `RealHerdr` y el `WorktreeService` del orquestador y lo pasa a `createApp`.
