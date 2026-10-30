# UW-15 — Tools del LunasQ MCP, run token y cierre de fase

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-15 · Código: `packages/server/src/mcp/`, `packages/schemas/src/mcp.ts`, `packages/db/src/runs.ts`, `packages/db/drizzle/0003_runs_context_read.sql`

## Contexto

`docs/design.md` (§MCPs y skills) lista las 7 tools y pide que validen el run token, que `get_task_context` sea obligatoria antes de cualquier tool de salida y que un handoff inválido se rechace con sus errores. ADR 0001 fija el SDK v2 stateless en Hono y ADR 0002 el header `X-LunasQ-Run-Token`. ADR 0007 deja a quien llama los hechos de cada guard y ADR 0013 deja a UW-15 la entrada de `submit_spec`. Faltaba decidir quién cierra el Run, cómo se registra la lectura del contexto, dónde vive el checklist y qué hace el gate de tests mientras UW-11 está pendiente.

## Decisión

- **Endpoint.** `/mcp` en `createApp`, con `createMcpHonoApp()`: valida Host y Origin para localhost. Cada request crea su `McpServer` y su transporte stateless. El run token se lee del header en cada request.
- **Token inválido.** Sin header, con un token desconocido o con el token de un Run cerrado, el handshake y `tools/list` funcionan, pero cada `tools/call` responde `isError` con `invalid_run_token` y no tiene efectos. No se responde 401 porque los clientes MCP lo interpretan como un pedido de OAuth.
- **Guardas.** Toda tool pasa por estas guardas, en orden:
  1. Run activo (`ended_at IS NULL`).
  2. Tool permitida en la fase del Run (`tool_not_allowed`): `submit_spec` en refine; `update_checklist` y `submit_for_verification` en implement; `submit_verdict` en verify. `get_task_context`, `ask_human` y `report_failure` se aceptan en todas.
  3. `get_task_context` ya leída (`context_required`).
  4. En verify, si el Run ya registró un veredicto pass, solo se aceptan `get_task_context` y `submit_verdict`. Así el token, que sigue vivo para la entrega, ya no puede llevar la tarea a `waiting_human` ni cerrar el Run como fallido.
- **Lectura del contexto.** La columna `runs.context_read_at` (migración `0003`) guarda la primera llamada a `get_task_context`; repetirla no mueve la marca. Por ser columna y no evento, la guarda es una lectura por clave del Run.
- **Errores.** La respuesta es `isError` con un cuerpo JSON `{error, message, issues?, output?}`. `issues` usa el formato `{path, message}` de `parseHandoff` (ADR 0006).
- **Handoff.** El `inputSchema` acepta `{handoff: objeto}` y la validación la hace `parseHandoff`: así los errores salen en español y se aplican las reglas entre campos. Después se comprueba que `phase`, `taskId` y `runId` sean los del Run (`handoff_mismatch`). Por último, los criterios se comparan contra la spec aprobada (`spec_mismatch`): `criterionTests` y `criteriaVerdicts` deben nombrar exactamente sus criterios. Un rechazo deja el Run abierto para corregir y reintentar.
- **Quién cierra el Run.** La tool de salida, en la misma transacción `IMMEDIATE` que guarda el handoff y aplica la transición. Así el token queda viejo en el acto, y un rechazo de la máquina de estados revierte todo, incluida la versión de spec (`SpecRepository.applySubmit`).
  - `submit_spec`, `submit_for_verification` y `submit_verdict` con reject cierran con `success`.
  - `report_failure` cierra con `failure` y su `failure_reason`.
  - `submit_verdict` con pass guarda el handoff con el Run abierto, porque `verdict_pass` lo emite la entrega (ADR 0007). Repetir el mismo veredicto es idempotente; uno distinto responde `verdict_already_recorded`.
  - El dispatcher (UW-16) solo detiene y limpia el pane.
- **`submit_for_verification`.** Cobertura de criterios → worktree limpio → commits → gate de tests → transacción. Detalle:
  - Con cambios sin commitear (`git status --porcelain`, incluidos archivos sin seguimiento) responde `dirty_worktree`, porque el gate debe correr sobre lo que va en los commits.
  - `CommitVerifier` (puerto) comprueba que cada SHA esté en el `HEAD` del worktree y no en la rama base, ni en la local ni en `origin/<base>` cuando existe (el worktree sale de `origin/<base>` y la local puede ir atrasada; [ADR uw-18-skills-fase](uw-18-skills-fase.md)). `GitCommitVerifier` lo hace con `git merge-base` por el `ProcessRunner`.
  - `TestGate` (puerto) corre el comando de tests del proyecto en el worktree. `ShellTestGate` es la implementación mínima hasta UW-11: sin comando de tests, el gate no pasa.
  - Los comandos de git pasan los argumentos tras `--end-of-options`, así una rama base con forma de opción no se interpreta como opción.
  - `ShellTestGate` corta a los 20 minutos por defecto (`DEFAULT_GATE_TIMEOUT_MS`, configurable).
  - Mientras corre el gate de un Run, otro `submit_for_verification` del mismo Run responde `gate_in_progress` y no lanza una segunda suite. El candado vive en memoria, porque el proceso es uno solo. El gate no se cancela si el cliente abandona la llamada: `ProcessRunner` no recibe señal de aborto.
  - El gate corre fuera de la transacción. Si mientras tanto el dispatcher cerró el Run, el cierre falla con `invalid_run_token`. Si la tarea cambió, la transición, que lleva `expected: in_progress/running`, se rechaza sin cerrar el Run.
  - Un gate en rojo responde `test_gate_failed` con la cola de la salida (4000 caracteres).
- **`ask_human`.** En una transacción aplica `ask_human` (running → waiting_human) y crea la Question con el evento `question.created`. Si la tarea ya espera al humano, se rechaza sin crear otra. Pausar el timeout y entregar la respuesta es de UW-22.
- **Checklist.** Sin tabla nueva: `update_checklist` agrega el evento `checklist.updated` con el snapshot completo de la task list aprobada, y el último evento es el checklist vigente. Repetir la misma marca no agrega evento. Los ids que no están en la spec se rechazan.
- **`report_failure`.** Aplica `run_failed` con actor `system`, el único permitido por ADR 0007: el agente declara el fallo y el sistema lo registra. `attempt` vale los Runs fallidos seguidos de la fase, desde el último `resume` de la tarea, más uno (`consecutiveFailures`).
- **`get_task_context`.** Devuelve `TaskContext` (`@lunasq/schemas`):
  - tarea, Run y proyecto (rama base y comando de tests);
  - spec aprobada; en refinamiento, además, la última versión con cambios pedidos y sus comentarios;
  - último handoff de implementación y veredictos anteriores;
  - el Run cerrado anterior de la misma fase, con su motivo de fallo y su handoff;
  - Questions y último checklist.

## Consecuencias

- El gate hereda el entorno del proceso de LunasQ, incluidos los tokens de `gh`. UW-11 debe pasarle un entorno mínimo al correrlo en el pane.
- Las convenciones del proyecto no viajan en `get_task_context`: el agente las lee del repo (CLAUDE.md, AGENTS.md) y de su skill. El contexto solo lleva la rama base y el comando de tests.
- Si se pierde la respuesta de una tool de salida exitosa, el reintento responde `invalid_run_token`, porque el Run ya cerró: no duplica efectos, pero no devuelve el resultado original. UW-18 debe indicar en las skills que ese error después de una tool de salida significa que la fase ya terminó.

- UW-16 crea el Run con su token y no cierra Runs que ya cerró una tool de salida. Al ver la tarea fuera de `running`, limpia el pane.
- UW-11 reemplaza `ShellTestGate` por la ejecución en un pane de herdr y guarda la salida. El puerto `TestGate` no cambia, salvo el campo `trigger`; también corre el gate antes de aceptar un pass ([ADR uw-11-gate-tests](uw-11-gate-tests.md)).
- El gate es síncrono dentro de la llamada MCP: una suite más larga que el timeout de tools de Claude Code (`MCP_TOOL_TIMEOUT`) corta la llamada. UW-16 debe fijar ese timeout en el perfil de la fase o UW-11 debe acotar la suite.
- UW-23 agrega a `submit_verdict` la validación de los revisores contra los hooks; UW-26 corre el gate final y emite `verdict_pass`.
- UW-18 documenta en las skills los códigos de error y que un rechazo se corrige en el mismo Run.
