# Compatibilidad de Codex CLI como proveedor de LunasQ

- **Fecha:** 2026-11-02
- **Versión de Codex CLI probada:** `codex-cli 0.147.0` (`codex --version`, macOS arm64). Documentación consultada en esa misma fecha.
- **Otras versiones del entorno:** herdr 0.9.5 (`herdr --version`); referencia de LunasQ: Claude Code ≥ 2.1.312 y Copilot CLI ≥ 1.0.0 (`packages/cli/src/doctor.ts`).
- **Tarea:** LunasQ #29 (`3ade2dc5-caef-47c1-b572-1296bde50ecd`).
- **Pregunta:** ¿Codex es 100 % compatible con LunasQ, como lo son Claude Code y Copilot CLI?

## Resumen

**No.** Codex cubre el arranque, el modo autónomo, el MCP con token por Run, las skills, el modelo/effort, `AGENTS.md` y el doctor sin trabajo de fondo. Quedan **seis puntos parciales** y **uno sin confirmar**; ningún punto es incompatible. En revisores, hooks y usage (5, 6 y 9) Codex queda al nivel de Copilot o por encima; en sesión y confianza de carpeta (7 y 10) queda por debajo hasta resolver B3 y B5. La recomendación es **integrar con limitaciones** (ver [Conclusión](#conclusión-y-recomendación)).

Las tres brechas que más trabajo piden:

1. **Sin `--session-id`:** Codex genera su propio id de sesión, así que el Run no puede fijarlo al arrancar.
2. **Hooks de evidencia sin tipo `http`:** `SubagentStart`/`SubagentStop` existen, pero solo como `command` o `mcp_tool`, y exigen confianza del hook.
3. **Usage:** Codex emite telemetría y un rollout JSONL con `token_count`, pero con un esquema distinto al de Claude Code; el collector actual no lo entiende.

## Fuentes consultadas

| Id | Fuente | Qué aportó |
| --- | --- | --- |
| F1 | <https://learn.chatgpt.com/docs/developer-commands?surface=cli> (la URL del intent) | Flags globales y de `exec`, sandbox y aprobaciones, `-c`/`--profile`, `resume`/`fork`, `mcp add`, `doctor`, `--dangerously-bypass-hook-trust` |
| F2 | <https://developers.openai.com/codex/hooks> (redirige a <https://learn.chatgpt.com/docs/hooks>) | Eventos de hooks, tipos de handler, campos de entrada, confianza de hooks |
| F3 | <https://developers.openai.com/codex/agent-configuration/subagents> (redirige a <https://learn.chatgpt.com/docs/agent-configuration/subagents>) | Subagentes en TOML, campos, ejecución en paralelo |
| F4 | <https://developers.openai.com/codex/build-skills> (redirige a <https://learn.chatgpt.com/docs/build-skills>) | Rutas de skills, formato de `SKILL.md`, invocación |
| F5 | <https://developers.openai.com/codex/config-file/config-reference> (redirige a <https://learn.chatgpt.com/docs/config-file/config-reference>) | `mcp_servers.<id>.*`, `model_reasoning_effort`, `projects.<path>.trust_level`, `otel.*`, `approval_policy`, `sandbox_mode`, `project_doc_fallback_filenames` |
| F6 | Repositorio <https://github.com/openai/codex> (`docs/agents_md.md`, `docs/config.md`) | Confirma que `AGENTS.md` y la configuración se documentan en developers.openai.com; menciona `requirements.toml` y hooks gestionados |
| F7 | Búsqueda web sobre OpenTelemetry de Codex: <https://docs.honeyhive.ai/v2/integrations/codex-cli>, <https://last9.io/docs/integrations/codex/>, <https://codex.danielvaughan.com/2026/04/26/codex-cli-opentelemetry-observability-monitoring-agent-sessions/> | Eventos y métricas de tokens. **Terceros:** los nombres de eventos y el nombre del servicio no coinciden entre guías |
| F8 | Código y ADRs del repo: `packages/adapters/src/agents/providers.ts`, `packages/server/src/dispatcher/dispatcher.ts`, `packages/server/src/mcp/copilot-reviewer.ts`, `packages/server/src/evidence/sources.ts`, `packages/cli/src/{install,doctor,paths,copilot-mcp,assets}.ts`, `docs/decisions/{0002,0004,0016,effort-por-fase,settings-proveedores,uw-10,uw-19,uw-20}`, `docs/decisions/0015-limite-de-uso-agente.md`, `docs/design.md` | Referencia de Claude y Copilot |

Comandos ejecutados (entorno local, sin modificar `~/.codex` del usuario; las pruebas con servidor usaron un `CODEX_HOME` temporal sin credenciales):

| Id | Comando | Resultado relevante |
| --- | --- | --- |
| C1 | `codex --help`, `codex exec --help`, `codex exec resume --help`, `codex mcp --help` | No existe `--session-id`; sí `-c`, `-m`, `-s`, `-a`, `--dangerously-bypass-approvals-and-sandbox`, `--add-dir`, `--ephemeral`, `--json`, `-o`, `--output-schema`, `exec resume [SESSION_ID]` |
| C2 | `herdr agent start --help` | `--kind` acepta `codex` (y `claude`, `copilot`) |
| C3 | `herdr integration status` | `codex: current (v10)` con hook `~/.codex/herdr-agent-state.sh` que publica la sesión (acción `session`) |
| C4 | `codex -c 'mcp_servers.lunasq.url="http://127.0.0.1:7777/mcp"' -c 'mcp_servers.lunasq.env_http_headers={"X-LunasQ-Run-Token"="LUNASQ_RUN_TOKEN"}' -c 'mcp_servers.lunasq.startup_timeout_sec=30' mcp get lunasq` | Transporte `streamable_http` con el header por entorno y el timeout, solo con overrides, sin tocar disco |
| C5 | `LUNASQ_RUN_TOKEN=run-env-codex-0001 codex exec --ephemeral --skip-git-repo-check -s read-only -c 'mcp_servers.lunasq.url="http://127.0.0.1:4999/mcp"' -c 'mcp_servers.lunasq.env_http_headers={"X-LunasQ-Run-Token"="LUNASQ_RUN_TOKEN"}' "di ok"` contra un servidor HTTP local que registra headers | El servidor vio `POST initialize` con `X-LunasQ-Run-Token: run-env-codex-0001`. El servidor respondía 404, así que no se probó el handshake completo ni una llamada a tool. Sin credenciales el modelo devolvió 401 (esperado). El encabezado de `exec` imprimió `session id: <uuid>` generado por Codex |
| C6 | `codex features list` | `hooks` estable y activo |
| C7 | Inspección de un rollout propio en `~/.codex/sessions/*.jsonl` (solo claves de estructura) | Línea `session_meta` con `session_id`/`id` y eventos `token_count` |
| C8 | `codex login status` y `codex doctor --help` | `Logged in using ChatGPT`; `doctor` admite `--json` y `--summary` |
| C9 | `copilot --help` (GitHub Copilot CLI 1.0.105) | `--no-custom-instructions`: «Disable loading of custom instructions from AGENTS.md and related files»; confirma que Copilot carga `AGENTS.md` por defecto |

**Límite de la prueba:** no se ejecutó una fase real de LunasQ con Codex (requiere crédito de modelo y un pane de herdr) ni se capturó la TUI de Codex en un worktree nuevo. Lo que depende de eso queda marcado como «parcial» o «sin confirmar».

## Tabla de puntos de integración

Veredictos: **compatible** (se resuelve con un mecanismo documentado o probado), **parcial** (se resuelve con trabajo o con menos garantías), **incompatible**, **sin confirmar**. Cada punto aparece una sola vez.

| # | Punto de integración | Claude Code | Copilot CLI | Codex CLI (propuesto) | Veredicto | Fuente |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Arranque en herdr (`agent start --kind`) | `herdr agent start <n> --kind claude --pane <p> -- <args>` (ADR 0004); `agent.kind` en `dispatcher.ts` | Igual con `--kind copilot` | `--kind codex`: herdr lo soporta de fábrica y ya tiene integración instalada | compatible | C2, C3 |
| 2 | Modo autónomo sin aprobaciones | LunasQ no fija un flag de permisos: van en los `args` del perfil | `--autopilot --allow-all-tools` reservados (ADR 0016) | `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) o `-a never -s workspace-write`. Reservar ambos flags y `-s`/`-a` en `RESERVED_CODEX_FLAGS` | compatible | F1, C1 |
| 3 | Conexión al MCP HTTP de LunasQ con token del Run | `--mcp-config <mcp.json> --strict-mcp-config`; header `${LUNASQ_RUN_TOKEN}` (ADR 0002) | Archivo temporal 0600 por Run con el token, `--additional-mcp-config @<archivo>` | Sin archivo: `-c 'mcp_servers.lunasq.url="…"'` y `-c 'mcp_servers.lunasq.env_http_headers={"X-LunasQ-Run-Token"="LUNASQ_RUN_TOKEN"}'`; el token vive solo en el entorno del pane (como Claude). Nota: no hay equivalente de `--strict-mcp-config` para la TUI, así que los MCP del `config.toml` del usuario también cargan (`--ignore-user-config` existe solo en `exec`) | compatible | F5, C4, C5 |
| 4 | Skills de fase (refine / implement / verify) | `~/.claude/skills/<fase>/SKILL.md`; invocación por nombre en el prompt | `~/.copilot/skills/<fase>/` (mismos `SKILL.md`) | `~/.agents/skills/<fase>/SKILL.md` con `name` y `description`; invocación explícita `$<skill>` o implícita por `description`. El texto de las skills habla de `mcp__lunasq__*` (nombres de Claude) y de la tool `Agent`: hay que verificar cómo nombra Codex las tools MCP y añadir una rama «Codex» como ya existe la de Copilot | compatible | F4 |
| 5 | Subagentes revisores | 4 archivos `.md` en `~/.claude/agents/lunasq/`, tools `Read, Grep, Glob, Bash`, lanzados con la tool `Agent` (ADR uw-19) | 4 perfiles `*.agent.md` en `~/.copilot/agents/lunasq/` y la tool MCP `run_reviewer`: LunasQ ejecuta `copilot --agent … --available-tools view grep glob` (`CopilotCliReviewerExecutor`) | Nativo: TOML en `~/.codex/agents/*.toml` con `name`, `description`, `developer_instructions`, `model`, `model_reasoning_effort`; se invocan por nombre en lenguaje natural y corren en paralelo. **No hay campo `tools`** y `sandbox_mode`/`mcp_servers` no se heredan del TOML, así que no se garantiza «solo lectura». Alternativa al nivel de Copilot: un ejecutor `codex exec -s read-only --ephemeral < prompt` detrás de `run_reviewer` | parcial | F3, F1, C1 |
| 6 | Hooks y evidencia de subagentes | Hooks `SubagentStart`/`SubagentStop` tipo `http` con header `$LUNASQ_RUN_TOKEN` hacia `POST /hooks/subagent` (ADR uw-19) | Sin hooks; LunasQ captura prompt y respuesta de cada revisor y escribe su propio transcript JSONL | Existen `SubagentStart`/`SubagentStop` con `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, pero los handlers soportados son `command` y `mcp_tool` (sin `http`), no hay expansión de entorno documentada y los hooks no gestionados requieren confianza (`/hooks` o `--dangerously-bypass-hook-trust`). Camino: hook `command` que haga `curl` con `$LUNASQ_RUN_TOKEN`, o ejecutor propio como Copilot | parcial | F2, C6 |
| 7 | Identidad de sesión (session-id / resume) | `--session-id <uuid>` fijado por el dispatcher (fuente nativa) | `--session-id <uuid>` | **No existe `--session-id`**: Codex asigna el uuid (`session id:` en el banner de `exec`; `session_meta` en el rollout). Se obtiene por la fuente 2 del diseño: la integración de herdr publica `agent_session`. Resume: `codex resume <id>` / `codex exec resume <id>` | parcial | C1, C3, C5, C7 |
| 8 | Modelo y reasoning effort | `--model`, `--effort` (ADR effort-por-fase) | `--model`, `--reasoning-effort` | `-m <modelo>` y `-c model_reasoning_effort="<nivel>"`. Los niveles dependen del modelo (`low`…`xhigh`, `max`, `ultra`); los de `EffortLevel` (`low`…`max`) entran | compatible | F1, F5 |
| 9 | Telemetría de usage | OTLP: evento `api_request` por llamada con run token en `OTEL_EXPORTER_OTLP_HEADERS` (ADR uw-20) | No disponible (`usage: "unavailable"`, totales parciales en UI) | Dos fuentes: bloque `[otel]` (`otel.exporter`, `otlp-http`/`otlp-grpc`, con endpoint y headers por exporter) y rollout JSONL con eventos `token_count` (visto en C7). El esquema de eventos de OTel solo está confirmado por guías de terceros y no coincide con el de Claude: hay que escribir otro parser | parcial | F5, F7, C7 |
| 10 | Diálogo de confianza de carpeta | `showsTrustDialog` + teclas `TRUST_ACCEPT_KEYS` (ADR 0004) | `showsCopilotTrustDialog` + `enter` | `-c 'projects."<worktree>".trust_level="trusted"'` en los args evita el diálogo (y habilita `.codex/` y hooks de proyecto). La documentación lo describe, pero **no se probó** la TUI de Codex en un worktree nuevo ni la detección de «listo» de herdr | parcial | F5, F1 |
| 11 | Instrucciones del repo (AGENTS.md) | Lee `CLAUDE.md` (no `AGENTS.md`); este repo mantiene `AGENTS.md`, que Claude solo ve si `CLAUDE.md` lo importa | Carga `AGENTS.md` y archivos relacionados como instrucciones personalizadas; `--no-custom-instructions` las desactiva (C9) | Lee `AGENTS.md` de forma nativa (`project_doc_fallback_filenames` para otros nombres). Es el archivo que ya mantiene este repo | compatible | F6, F5, C9 |
| 12 | Instalación (`lunasq install`) | Copia skills y subagentes a `~/.claude`, `herdr integration install claude`, escribe `mcp.json` y `claude-settings.json` (hooks) | Copia a `~/.copilot` y mantiene la entrada `lunasq` en `~/.copilot/mcp-config.json` | `herdr integration install codex`; skills a `~/.agents/skills`; subagentes `.md` → TOML en `~/.codex/agents/` (hay que generarlo); el MCP va por `-c`, sin escribir `config.toml` del usuario; hooks solo si se adopta la vía `command` (punto 6) | parcial | F4, F3, C3 |
| 13 | Doctor | `claude --version` ≥ mínimo, estado de la integración de herdr, archivos instalados | `copilot --version` ≥ mínimo, MCP registrado | `codex --version` (0.147.0), `codex doctor --json --summary`, `codex login status`, `herdr integration status` (línea `codex:`) | compatible | C1, C3, C8 |
| 14 | Detección de límite de uso | `showsUsageLimit` sobre la pantalla del TUI (ADR 0015-límite) | No hay detección específica (cae en el flujo de agente detenido) | Los textos de la TUI de Codex al agotar la cuota no se capturaron | sin confirmar | — |

**Recuento:** 7 compatibles, 6 parciales, 1 sin confirmar, 0 incompatibles.

## Brechas y trabajo necesario

Cada brecha corresponde a un punto parcial o sin confirmar.

### B1 — Subagentes revisores sin restricción de herramientas (punto 5)

- **Problema:** el TOML de un agente de Codex no tiene `tools` ni hereda `sandbox_mode`; no se puede garantizar que un revisor sea de solo lectura.
- **Workaround:** repetir el patrón de Copilot: `run_reviewer` ejecuta `codex exec -s read-only --ephemeral --output-last-message <archivo> < prompt` en el worktree, con lista de entorno acotada, timeout de 5 min y transcript propio.
- **Archivos y paquetes:**
  - `packages/server/src/mcp/` — nuevo `codex-reviewer.ts` a partir de `copilot-reviewer.ts`; ajustar `service.ts`, `routes.ts` e `index.ts` para despachar por `agentKind`.
  - `packages/adapters/src/agents/providers.ts` — `reviewerExecution` hoy es `"native-hooks" | "lunasq-runner"`; Codex usa `lunasq-runner`.
  - `assets/agents/` — nueva carpeta `codex/` con los revisores en TOML.
  - `assets/skills/verify-task/SKILL.md` — rama «Codex CLI» en el paso de lanzar revisores.
  - `packages/server/src/evidence/sources.ts` — un `TranscriptSource` equivalente a `CopilotReviewerTranscriptSource`.

### B2 — Hooks de evidencia sin `http` (punto 6)

- **Problema:** `POST /hooks/subagent` espera un hook `http` con el token en un header; Codex solo ejecuta `command`/`mcp_tool` y pide confianza.
- **Workaround:** con el ejecutor propio de B1 no se necesitan hooks (igual que Copilot). Si se quisiera evidencia nativa: un hook `command` que haga `curl` con `$LUNASQ_RUN_TOKEN` y agregar `--dangerously-bypass-hook-trust` solo si LunasQ controla la fuente del hook.
- **Archivos y paquetes:** `packages/server/src/dispatcher/hook-settings.ts` (hoy genera el settings de hooks de Claude; haría falta un generador para Codex), `packages/server/src/subagents/routes.ts` (endpoint `POST /hooks/subagent`; ya valida `SubagentHookInput` con los campos `agent_id`, `agent_type` y `agent_transcript_path`, a confirmar con una captura real de Codex), `packages/cli/src/paths.ts` y `install.ts` (ruta del `hooks.json`).

### B3 — Sin `--session-id` (punto 7)

- **Problema:** el dispatcher fija `--session-id` y lo usa para descartar hooks y registros de usage con otra sesión (`agentSessionSource: "native"`).
- **Workaround:** tratar a Codex como proveedor de **sesión reportada** (fuente 2 del diseño): `agentSessionSource` distinto de `native`, `resolveSession` con `agent_session` de herdr, y los filtros por `session_id` pasan a basarse en el run token. Verificar que el hook de herdr publique el id antes del primer prompt.
- **Archivos y paquetes:** `packages/server/src/dispatcher/dispatcher.ts` (`resolveSession`, `unblockStart`), `packages/adapters/src/agents/providers.ts` (`AgentProviderContext.sessionId` pasa a opcional), `packages/db/src/runs.ts`, `packages/server/src/usage/` y `packages/server/src/subagents/routes.ts` (los filtros por sesión).

### B4 — Usage con otro esquema (punto 9)

- **Problema:** el collector de LunasQ (`/v1/logs`, evento `api_request`) no entiende los eventos de Codex y el esquema de OTel de Codex solo está confirmado por terceros.
- **Workaround:** en una primera versión, `usage: "unavailable"` como Copilot (la UI ya lo marca como parcial). Después, leer los eventos `token_count` del rollout JSONL al cerrar el Run, o configurar `otel.exporter` con `-c` y un parser nuevo. Antes de elegir, capturar un lote real con 0.147.0.
- **Archivos y paquetes:** `packages/server/src/usage/` (parser nuevo, `source = otel` o `transcript`), `packages/server/src/dispatcher/dispatcher.ts` (variables de entorno por proveedor; hoy borra las de OTLP solo para Copilot), `packages/web/src/components/task/usage.tsx` (etiqueta de Runs sin métricas).

### B5 — Confianza de carpeta sin probar (punto 10)

- **Problema:** el mecanismo `projects.<path>.trust_level` está documentado, pero no se comprobó que impida el diálogo ni cómo lo detecta herdr.
- **Workaround:** pasar `-c projects."<worktree>".trust_level="trusted"` y, como respaldo, un detector `showsCodexTrustDialog` con sus teclas tras capturar la pantalla con `herdr agent read`.
- **Archivos y paquetes:** `packages/adapters/src/herdr/claude-tui.ts` y `fake.ts` (detector y teclas), `packages/adapters/src/index.ts` (export), `packages/server/src/dispatcher/dispatcher.ts` (`unblockStart`).

### B6 — Instalación de assets de Codex (punto 12)

- **Problema:** la ruta de skills es `~/.agents/skills` (compartida con otros agentes) y los subagentes son TOML, no Markdown.
- **Trabajo:**
  - `packages/cli/src/paths.ts`: `codexHome`, `codexSkills` (`~/.agents/skills`), `codexAgents` (`~/.codex/agents`).
  - `packages/cli/src/assets.ts`: nuevos `kind` y generación de los TOML.
  - `packages/cli/src/install.ts`: `herdr integration install codex`.
  - `packages/cli/src/doctor.ts`: `checkCodex`, `MINIMUM.codex` y el estado de la integración.
  - Respetar `isForeign` y el manifiesto: `~/.agents/skills` puede tener skills ajenas.

### B7 — Detección del límite de uso (punto 14)

- **Problema:** no se capturó el texto de la TUI de Codex al agotar la cuota.
- **Trabajo:** capturarlo con `herdr agent read` y añadir un `USAGE_LIMIT_PATTERN` propio. Mientras tanto un Run de Codex que choque con el límite cae en el flujo de «agente detenido» (nudges y reintentos), el problema que resolvió el ADR de límite de uso.
- **Archivos y paquetes:** `packages/adapters/src/herdr/claude-tui.ts`, `packages/server/src/reconciler/watcher.ts`.

### Trabajo transversal para agregar el `AgentKind`

- `packages/schemas/src/enums.ts`: `AgentKind` pasa a `["claude", "copilot", "codex"]` (propaga a `settings.ts`, el perfil de proyecto y la UI de Settings, con default habilitado según `settings-proveedores`).
- `packages/adapters/src/agents/providers.ts`: `codexProvider` con `RESERVED_CODEX_FLAGS` (`--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `-s`, `--sandbox`, `-a`, `--ask-for-approval`, `-m`, `--model`, `-c`/`--config` para las claves de LunasQ, `--profile`), rechazo del terminador `--` y de `--dangerously-bypass-hook-trust` en `args`.
- `packages/server/src/dispatcher/dispatcher.ts`: composición de los `-c` (MCP, confianza, effort) y limpieza del entorno de pane por proveedor (`CLAUDE_*`, `OTEL_*`).
- `packages/db`: `runs.agent_kind` tiene un CHECK generado desde `AgentKind` (`runs_agent_kind_enum` en `packages/db/src/schema.ts`), así que agregar `codex` pide una migración que reconstruya la tabla; ver el patrón de `settings-proveedores` para la reconstrucción de tablas con triggers.
- `packages/web`: etiquetas de proveedor en `settings.tsx`, `project-form-dialog.tsx` y `dispatch-paused-banner.tsx`.
- `docs/decisions/0016-proveedores-agente.md` y `docs/design.md` (§Consumo, §Riesgos): actualizar tras decidir.
- Pruebas: contrato real contra `codex` (arranque en herdr, MCP con token, `exec -s read-only`), además de los fakes.

## Conclusión y recomendación

**Paridad total con Claude Code y Copilot CLI: no.** La tabla tiene 6 puntos parciales y 1 sin confirmar. No hay incompatibles: cada brecha tiene un workaround o un trabajo acotado, y en los puntos 5, 6 y 9 Codex queda al menos al nivel de Copilot.

**Recomendación: integrar con limitaciones.**

1. Primera entrega (el mínimo para despachar fases): `AgentKind`, provider, MCP por `-c`, skills, instalación y doctor (puntos 1–4, 8, 11–13), con B3 (sesión reportada) y B5 (confianza). Con esto Codex puede refinar, implementar y entregar.
2. Verificación con revisores: B1 reutiliza el mecanismo de Copilot, por lo que la verificación con Codex tendría la misma garantía que la de Copilot, que el ADR 0016 ya declara no paritaria con Claude.
3. Usage (B4) y límite de uso (B7) pueden salir después: Codex quedaría marcado como «sin métricas» como Copilot.
4. Antes de empezar: ejecutar una fase real de Codex en un worktree nuevo para cerrar el punto 10 y el 14, y capturar un lote de OTel de 0.147.0.

Riesgos a vigilar: la interfaz de Codex cambia rápido (la documentación de mcp-server y los niveles de effort ya difieren entre fuentes y la versión local), por lo que `doctor` debe fijar una versión mínima y una prueba de contrato.
