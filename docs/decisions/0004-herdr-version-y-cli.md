# 0004 — herdr: versión mínima 0.9.5 (protocol 22) y comportamiento real de CLI y socket

- Estado: aceptada
- Fecha: 2026-10-28
- Unidad: UW-00 (spike d) · Código y salidas: `spikes/herdr/` (`outputs/01–22`, `api-schema.json`, `events*.ndjson`)

## Contexto

herdr es pre‑1.0 y el diseño (`docs/design.md`, Dispatcher e integración con herdr) asume primitivas de su CLI y socket. Había que fijar la versión mínima y comprobar la salida real de cada primitiva antes de UW-02.

## Entorno del spike

herdr 0.9.5, canal stable, `protocol: 22`, `schema_version: 1`. Servidor headless aislado con `herdr --session lunasq-spike server` (socket en `~/.config/herdr/sessions/lunasq-spike/herdr.sock`); la sesión por defecto del usuario no se tocó. Repo de juguete local; Claude Code 2.1.312 como agente.

## Primitivas: diseño vs realidad

| Diseño | Comando real | Resultado | Diferencia con el diseño |
| --- | --- | --- | --- |
| `workspace create` con cwd y label | `workspace create --cwd P --label L --no-focus [--env K=V]` | `result.workspace`, `result.tab`, `result.root_pane` con ids `w1`, `w1:t1`, `w1:p1` | Ninguna. Los ids son opacos y los asigna herdr: guardarlos, no derivarlos |
| `worktree create` crea checkout + branch | `worktree create --workspace W --branch B --base REF [--path P] --label L --no-focus` | Crea branch y checkout (por defecto en `~/.herdr/worktrees/<repo>/<branch-slug>`) y lo abre como workspace nuevo (`w2`) agrupado | **No es idempotente**: repetirlo falla con `worktree_create_failed` (`already exists`). El adapter debe hacer `worktree list` → `open` si existe, `create` si no |
| `worktree open` en fases siguientes | `worktree open --workspace W --branch B` | Idempotente: si ya está abierto devuelve `already_open: true` y el mismo workspace | Ninguna |
| `agent start` sobre un pane de shell libre | `pane split <pane> --direction right --cwd P --env K=V --no-focus` y luego `agent start <nombre> --kind claude --pane <id> [--timeout MS] -- <args>` | Los args después de `--` llegan intactos a `claude`; el env de `pane split --env` llega al proceso | `agent start` **no crea pane**: hace falta `pane split` (o la root pane). El env por pane se fija en `pane split`/`workspace create`, no en `agent start` |
| Agente listo tras `agent start` | — | En un worktree nuevo Claude Code muestra el diálogo de confianza de carpeta → `agent start` devuelve `agent_not_ready` y el agente queda `blocked` | **Nuevo**: el dispatcher debe resolver la confianza del worktree antes de arrancar (o detectar ese `blocked` y tratarlo). En el spike se aceptó con `agent send-keys <a> down enter`. Ver pendientes |
| `agent prompt` (opcionalmente con wait) | `agent prompt <a> "<texto>" --wait --timeout MS` | Devuelve `agent_prompted` con `agent_status: done` y `completion_seq` | Ninguna. Con `--wait` exige ver `working`/`blocked` en ≤5 s o devuelve `agent_prompt_stalled` |
| `agent wait` | `agent wait <a> [--until idle|working|blocked|done|unknown] [--timeout MS]` | `agent_info` | Ninguna |
| `pane report-metadata` con tokens | `pane report-metadata <pane> --source lunasq --title T --token task=t1 --token phase=refine --token iter=1` | Exit 0 **sin salida**; `title` y `tokens` aparecen en `agent get` y en el snapshot | Updates con `seq` menor o igual al último visto para ese `--source` se **descartan en silencio** (observado al repetir ráfagas con los mismos `seq`, ver `flood.ts`): usar `seq` monotónico (o no enviarlo) |
| `notification show` | `notification show <título> --body B --sound none` | `{"shown": false, "reason": "disabled"}` | Con la config por defecto (`[ui.toast] delivery = "off"`) no se muestra nada. `lunasq install`/`doctor` deben configurarlo o avisar |
| `session.snapshot` | `api snapshot` (método `session.snapshot`) | `result.snapshot` con `agents`, `panes`, `tabs`, `workspaces`, `layouts`, `version`, `protocol`; los agentes traen `name`, `agent_status`, `tokens`, `title`, `agent_session` | Ninguna |
| `events.subscribe` a `pane.agent_status_changed` | Request `{"id","method":"events.subscribe","params":{"subscriptions":[{"type":…}]}}` por el socket | `subscription_started` y luego líneas `{"event","data"}` | **`pane.agent_status_changed` exige `pane_id`**: la suscripción es por pane, no global (el schema lo marca como requerido y sin `pane_id` la request falla con `invalid_request: missing field `pane_id``). Globales: `workspace.*`, `worktree.*`, `tab.*`, `pane.created/closed/updated/exited/agent_detected`, `layout.updated`. Los nombres en `event` mezclan formatos (`pane_created`, `workspace_metadata_updated` vs `pane.agent_status_changed`) |
| `events_lost` cuando el consumidor se atrasa | Consumidor pausado + 30 000 updates | herdr cerró el stream tras ~100 eventos en buffer, **sin mensaje `events_lost`**; `events_lost` tampoco existe en el schema de protocol 22 | Tratar cualquier cierre del stream como pérdida de eventos: reconectar, re‑suscribir y reconciliar con `session.snapshot` (el loop de reconciliación del diseño ya lo cubre) |
| Identidad de sesión (`agent_session`) | `agent get`/`snapshot` | Con la integración oficial instalada, herdr reporta `agent_session: {kind: "id", source: "herdr:claude", value: <uuid de Claude>}` | Confirma la fuente 2 del diseño. La fuente 1 (`claude --session-id <uuid>`) también existe en el CLI |
| `pane close`, `worktree remove` | `pane close <pane>`, `worktree remove --workspace W [--force]` | `ok`; `worktree remove` borra el checkout, **cierra su workspace** y conserva el branch | Ninguna (el branch queda, como dice el diseño) |

Otros comportamientos del socket y la CLI:

- El socket Unix atiende **una request por conexión** (responde y cierra), salvo `events.subscribe`, que mantiene el stream abierto.
- Errores del servidor: stdout vacío, JSON `{"error":{"code","message"},"id"}` en stderr y exit 1; errores de sintaxis de la CLI, exit 2.
- `herdr <grupo> <sub> --help` imprime la ayuda global; la sintaxis por grupo sale de `herdr <grupo>` sin subcomando, y la referencia completa de `herdr api schema --json`.
- Bajo carga, herdr coalesce updates de metadata (200 updates → 43 eventos en un consumidor normal).

## Decisión

- Versión mínima **herdr 0.9.5 con `protocol` 22**; `lunasq doctor` la verifica con `herdr status` (campos `version`, `protocol`, `endpoint_compatible`; ver `outputs/00-herdr-status.txt`).
- El adapter de herdr (UW-02) sigue `docs/tech-stack.md`: CLI con salida JSON para las operaciones y una conexión dedicada al socket para `events.subscribe`. CLI y socket hablan el mismo protocolo (la CLI es un cliente del socket, una request por conexión), así que UW-02 puede pasar una operación al socket sin cambiar tipos; ambos se tipan con `herdr api schema --json`.
- Aplica las diferencias de la tabla: `worktree list`/`open` antes de `create`, `pane split --env` antes de `agent start`, suscripción a `pane.agent_status_changed` por pane al despachar, `seq` monotónico en metadata, y cierre de stream tratado como `events_lost`.
- La suite de contrato real de UW-02 usa un servidor headless en una sesión con nombre propio, como este spike.

## Pendientes para otras unidades

- **UW-16 / UW-28 — confianza de carpeta de Claude Code**: cada worktree nuevo arranca `blocked` por el diálogo de confianza. Opciones a validar: pre‑aceptar la confianza para el directorio de worktrees en la configuración de Claude Code durante `lunasq install`, o que el dispatcher detecte ese diálogo concreto y lo acepte. No se decide aquí.
- **UW-06 / UW-28 — notificaciones**: con `ui.toast.delivery = "off"` herdr no muestra nada; decidir si `lunasq install` lo cambia o solo `doctor` avisa.

## Adenda UW-02 (2026-10-28)

Comportamientos encontrados al implementar el adapter (`packages/adapters/src/herdr/`), cubiertos por su suite de contrato:

- **Un workspace creado con `workspace create` no trae `worktree` (checkout) en `workspace list` ni en el snapshot.** El adapter no puede reencontrar el workspace de un proyecto por su cwd: `ensureWorkspace` usa el id guardado en Project y, si ya no existe, el workspace principal con el mismo label. LunasQ controla los labels de sus proyectos.
- **Rutas:** herdr reporta a veces la ruta pedida y a veces la real (`/var` → `/private/var` en macOS) y colapsa el home a `~`. El adapter normaliza (expande `~` y resuelve symlinks) toda ruta que devuelve.
- **Una conexión por suscripción:** una segunda request `events.subscribe` por la misma conexión hace que herdr la cierre. El adapter abre una conexión por suscripción. Si herdr rechaza una suscripción (respuesta `error`, p. ej. un pane que ya no existe), emite `subscription_failed` y no reintenta.
- **Códigos de error usados para la idempotencia:** `workspace_not_found` (`workspace close`, `worktree remove`), `pane_not_found`, `agent_not_found`, `agent_name_taken` (arranque concurrente con el mismo nombre), `agent_not_ready` (arrancó bloqueado) y `timeout` (`agent wait`/`start`).
- **`agent prompt`:** el texto va como posicional, aunque empiece con `-`. Detrás de `--` herdr lo rechaza.
- **Suite real sin Claude Code:** `pane report-agent` permite que cualquier proceso se reporte como agente. La suite usa un `claude` stub que entra al PATH del pane vía `ZDOTDIR`, porque el shell de login de macOS reescribe el `PATH` heredado. Requiere zsh y se corre con `pnpm --filter @lunasq/adapters test:herdr`.
