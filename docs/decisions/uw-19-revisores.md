# UW-19 — Subagentes revisores y registro de sus ejecuciones

- Estado: aceptada
- Fecha: 2026-10-29
- Unidad: UW-19 · Código: `assets/agents/lunasq/`, `packages/schemas/src/subagents.ts`, `packages/db/src/run-subagents.ts`, `packages/db/drizzle/0005_run_subagents.sql`, `packages/server/src/subagents/`, `packages/server/src/dispatcher/hook-settings.ts`

## Contexto

`docs/design.md` (§Verificación con subagentes) define 4 revisores de solo lectura en Opus, con salida compacta. También pide que los hooks `SubagentStart` y `SubagentStop` le avisen a LunasQ qué subagentes corrieron en cada Run, porque UW-23 rechaza un veredicto que reporta un revisor que no aparece en esos hooks. El criterio de UW-19: los 4 se lanzan desde una sesión de prueba y LunasQ registra cada ejecución. Faltaba decidir cómo llegan los hooks a la sesión del agente, cómo se autentican y dónde se guardan.

## Resultado del spike

Con Claude Code 2.1.312, `claude -p --settings <archivo>` y un subagente en `<repo>/.claude/agents/lunasq/`:

- Claude Code descubre los subagentes dentro de un subdirectorio de `agents/`. Así se confirma la ruta `~/.claude/agents/lunasq/` del diseño.
- Un hook `type: "http"` con `headers: {"X-LunasQ-Run-Token": "$LUNASQ_RUN_TOKEN"}` y `allowedEnvVars: ["LUNASQ_RUN_TOKEN"]` llega con el token expandido del entorno, tanto en `SubagentStart` como en `SubagentStop`.
- El input trae `session_id`, `agent_id` y `agent_type` (el `name` del subagente). `SubagentStop` agrega `agent_transcript_path` y `last_assistant_message`, entre otros.
- Sin `CLAUDE_CODE_FORK_SUBAGENT=0`, la sesión lanzó el subagente en segundo plano.

## Decisión

- **Revisores.** Cuatro archivos en `assets/agents/lunasq/`, con nombre de archivo igual al `name` y a `REVIEWER_NAMES` de `@lunasq/schemas`. Llevan `model: opus` y `tools: Read, Grep, Glob, Bash`: sin Edit, Write, NotebookEdit ni Agent.
  - Cada uno prohíbe escribir, también por Bash, y deja la suite de tests al approver.
  - La salida es una línea por hallazgo, `[<severidad>] <archivo>:<línea> · <criterio> · <evidencia>`, o `SIN HALLAZGOS`. Las severidades son las de `Finding` del handoff de verificación (`critical`, `major`, `minor`), así el approver copia los campos sin traducir.
  - El revisor de código lleva el checklist de coherencia de tests. En la prueba de reversión solo señala qué tests deberían fallar, porque revertir el código lo hace el approver.
  - El MCP de navegador para UI y UX no va en v1: depende del proyecto, y un proyecto puede sobrescribir el revisor en su `.claude/agents/`.
- **Hooks por settings estable.** `ensureHookSettings(path, url)` escribe, como `ensureMcpConfig` (ADR 0002), un solo archivo por instalación con los dos hooks `http` hacia `POST /hooks/subagent`. El token va como `$LUNASQ_RUN_TOKEN` y nunca toca disco. `agentArgs` agrega `--settings <archivo>` en todas las fases, porque un implementador también puede lanzar subagentes y registrarlos no cuesta nada. `--settings` pasa a ser un flag reservado: un perfil que lo trae falla con `profile_conflict`. `Orchestrator` recibe `hooks: {settingsPath, url}` y escribe el archivo al arrancar.
- **`CLAUDE_CODE_FORK_SUBAGENT=0`.** Va por defecto en el entorno de cada pane, como `MCP_TOOL_TIMEOUT`, y `paneEnv` puede sobrescribirlo.
- **Endpoint.** `POST /hooks/subagent` en `createApp`. Valida el input con `SubagentHookInput`, que tolera campos nuevos de Claude Code, y responde 400 si no es un `SubagentStart` o `SubagentStop`. Busca el Run activo por el header `X-LunasQ-Run-Token`. Con un token ausente, desconocido o de un Run cerrado, responde `{}` sin efectos. No responde 401: un error del hook no detiene a Claude Code, pero ensucia la pantalla del agente, y una sesión vieja no tiene nada que corregir.
- **Registro.** La tabla `run_subagents` tiene una fila por `(run_id, agent_id)`, con `agent_type`, `started_at`, `stopped_at` y `transcript_path`, y se borra con su Run. Es una tabla y no un evento porque UW-23 la consulta por Run y porque los hooks se repiten o se pierden: cualquiera de los dos crea la fila, el primero de cada uno fija su tiempo y repetirlo no cambia nada. Los tiempos son los del servidor, porque el input de los hooks no trae hora.
- **Prueba real.** `pnpm --filter @lunasq/server test:claude` levanta la app en un puerto local, instala los revisores en un repo temporal y abre `claude -p` con el settings y el token en el entorno, como en un pane. Después comprueba que los 4 quedaron registrados con inicio, fin y transcript. Usa `LUNASQ_REVIEWER_MODEL=haiku` por defecto para no gastar Opus; con `opus` prueba los archivos tal cual. Pasó con los dos.

## Consecuencias

- **UW-23**: `submit_verdict` compara los revisores `ran` con `RunSubagentRepository.forRun(runId)` por `agentType`. Un revisor con `started_at` pero sin `stopped_at` no terminó.
- **UW-24**: `transcript_path` apunta al transcript de cada subagente, para convertirlo a markdown en la evidencia.
- **UW-28**: `lunasq install` copia `assets/agents/lunasq/` a `~/.claude/agents/lunasq/` y fija la ruta del settings y la URL del endpoint que recibe el `Orchestrator`. `doctor` puede repetir la prueba real con haiku.
- **UW-18**: la skill `verify-task` lanza los revisores por nombre y no los pone en segundo plano.
- El endpoint no valida Host ni Origin. Sin un token activo no tiene efectos, y el token tiene 256 bits.
- `--settings` se suma a los settings de usuario y de proyecto, no los reemplaza. Un hook de usuario sigue corriendo junto a los de LunasQ.
