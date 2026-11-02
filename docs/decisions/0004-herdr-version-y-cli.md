# 0004 — herdr: minimum version 0.9.5 (protocol 22) and real CLI and socket behavior

- Status: accepted
- Date: 2026-10-28
- Unit: UW-00 (spike d) · Code and outputs: `spikes/herdr/` (`outputs/01–22`, `api-schema.json`, `events*.ndjson`)

## Context

herdr is pre‑1.0 and the design (`docs/design.md`, Dispatcher and herdr integration) assumes CLI and socket primitives. The minimum version had to be fixed and the real output of each primitive checked before UW-02.

## Spike environment

herdr 0.9.5, stable channel, `protocol: 22`, `schema_version: 1`. Isolated headless server with `herdr --session lunasq-spike server` (socket at `~/.config/herdr/sessions/lunasq-spike/herdr.sock`); the user's default session was not touched. Local toy repo; Claude Code 2.1.312 as the agent.

## Primitives: design vs reality

| Design | Real command | Result | Difference from the design |
| --- | --- | --- | --- |
| `workspace create` with cwd and label | `workspace create --cwd P --label L --no-focus [--env K=V]` | `result.workspace`, `result.tab`, `result.root_pane` with ids `w1`, `w1:t1`, `w1:p1` | None. The ids are opaque and assigned by herdr: store them, do not derive them |
| `worktree create` creates checkout + branch | `worktree create --workspace W --branch B --base REF [--path P] --label L --no-focus` | Creates the branch and checkout (by default in `~/.herdr/worktrees/<repo>/<branch-slug>`) and opens it as a new grouped workspace (`w2`) | **Not idempotent**: repeating it fails with `worktree_create_failed` (`already exists`). The adapter must do `worktree list` → `open` if it exists, `create` if not |
| `worktree open` in later phases | `worktree open --workspace W --branch B` | Idempotent: if already open it returns `already_open: true` and the same workspace | None |
| `agent start` on a free shell pane | `pane split <pane> --direction right --cwd P --env K=V --no-focus` and then `agent start <name> --kind claude --pane <id> [--timeout MS] -- <args>` | The args after `--` reach `claude` intact; the env from `pane split --env` reaches the process | `agent start` **does not create a pane**: `pane split` (or the root pane) is needed. The per‑pane env is set in `pane split`/`workspace create`, not in `agent start` |
| Agent ready after `agent start` | — | In a new worktree Claude Code shows the folder trust dialog → `agent start` returns `agent_not_ready` and the agent is left `blocked` | **New**: the dispatcher must resolve the worktree's trust before starting (or detect that `blocked` and handle it). In the spike it was accepted with `agent send-keys <a> down enter`. See pending items |
| `agent prompt` (optionally with wait) | `agent prompt <a> "<text>" --wait --timeout MS` | Returns `agent_prompted` with `agent_status: done` and `completion_seq` | None. With `--wait` it requires seeing `working`/`blocked` within ≤5 s or returns `agent_prompt_stalled` |
| `agent wait` | `agent wait <a> [--until idle|working|blocked|done|unknown] [--timeout MS]` | `agent_info` | None |
| `pane report-metadata` with tokens | `pane report-metadata <pane> --source lunasq --title T --token task=t1 --token phase=refine --token iter=1` | Exit 0 **with no output**; `title` and `tokens` appear in `agent get` and in the snapshot | Updates with `seq` less than or equal to the last one seen for that `--source` are **silently discarded** (observed when repeating bursts with the same `seq`, see `flood.ts`): use a monotonic `seq` (or do not send it) |
| `notification show` | `notification show <title> --body B --sound none` | `{"shown": false, "reason": "disabled"}` | With the default config (`[ui.toast] delivery = "off"`) nothing is shown. `lunasq install`/`doctor` must configure it or warn |
| `session.snapshot` | `api snapshot` (method `session.snapshot`) | `result.snapshot` with `agents`, `panes`, `tabs`, `workspaces`, `layouts`, `version`, `protocol`; the agents carry `name`, `agent_status`, `tokens`, `title`, `agent_session` | None |
| `events.subscribe` to `pane.agent_status_changed` | Request `{"id","method":"events.subscribe","params":{"subscriptions":[{"type":…}]}}` over the socket | `subscription_started` and then `{"event","data"}` lines | **`pane.agent_status_changed` requires `pane_id`**: the subscription is per pane, not global (the schema marks it as required and without `pane_id` the request fails with `invalid_request: missing field `pane_id``). Global ones: `workspace.*`, `worktree.*`, `tab.*`, `pane.created/closed/updated/exited/agent_detected`, `layout.updated`. The names in `event` mix formats (`pane_created`, `workspace_metadata_updated` vs `pane.agent_status_changed`) |
| `events_lost` when the consumer falls behind | Paused consumer + 30,000 updates | herdr closed the stream after ~100 buffered events, **with no `events_lost` message**; `events_lost` does not exist in the protocol 22 schema either | Treat any stream close as event loss: reconnect, re‑subscribe and reconcile with `session.snapshot` (the design's reconciliation loop already covers it) |
| Session identity (`agent_session`) | `agent get`/`snapshot` | With the official integration installed, herdr reports `agent_session: {kind: "id", source: "herdr:claude", value: <Claude uuid>}` | Confirms the design's source 2. Source 1 (`claude --session-id <uuid>`) also exists in the CLI |
| `pane close`, `worktree remove` | `pane close <pane>`, `worktree remove --workspace W [--force]` | `ok`; `worktree remove` deletes the checkout, **closes its workspace** and keeps the branch | None (the branch stays, as the design says) |

Other socket and CLI behaviors:

- The Unix socket serves **one request per connection** (answers and closes), except `events.subscribe`, which keeps the stream open.
- Server errors: empty stdout, JSON `{"error":{"code","message"},"id"}` on stderr and exit 1; CLI syntax errors, exit 2.
- `herdr <group> <sub> --help` prints the global help; the per‑group syntax comes from `herdr <group>` without a subcommand, and the full reference from `herdr api schema --json`.
- Under load, herdr coalesces metadata updates (200 updates → 43 events in a normal consumer).

## Decision

- Minimum version **herdr 0.9.5 with `protocol` 22**; `lunasq doctor` verifies it with `herdr status` (fields `version`, `protocol`, `endpoint_compatible`; see `outputs/00-herdr-status.txt`).
- The herdr adapter (UW-02) follows `docs/tech-stack.md`: CLI with JSON output for the operations and a dedicated socket connection for `events.subscribe`. The CLI and the socket speak the same protocol (the CLI is a socket client, one request per connection), so UW-02 can move an operation to the socket without changing types; both are typed with `herdr api schema --json`.
- It applies the table's differences: `worktree list`/`open` before `create`, `pane split --env` before `agent start`, per‑pane subscription to `pane.agent_status_changed` on dispatch, monotonic `seq` in metadata, and stream close treated as `events_lost`.
- UW-02's real contract suite uses a headless server in a session with its own name, like this spike.

## Pending items for other units

- **UW-16 / UW-28 — Claude Code folder trust**: each new worktree starts `blocked` because of the trust dialog. Options to validate: pre‑accept the trust for the worktrees directory in Claude Code's configuration during `lunasq install`, or have the dispatcher detect that specific dialog and accept it. Resolved in [ADR uw-16-dispatcher](uw-16-dispatcher.md): the dispatcher recognizes the dialog on screen and accepts it with `agent send-keys <a> down enter` (`sendKeys` in the adapter).
- **UW-06 / UW-28 — notifications**: with `ui.toast.delivery = "off"` herdr shows nothing. Resolved in [ADR 0009](0009-notificaciones.md): `install` does not change it and `doctor` warns.

## Addendum UW-02 (2026-10-28)

Behaviors found while implementing the adapter (`packages/adapters/src/herdr/`), covered by its contract suite:

- **A workspace created with `workspace create` carries no `worktree` (checkout) in `workspace list` or in the snapshot.** The adapter cannot find a project's workspace again by its cwd: `ensureWorkspace` uses the id stored in Project and, if it no longer exists, the main workspace with the same label. LunasQ controls its projects' labels.
- **Paths:** herdr sometimes reports the requested path and sometimes the real one (`/var` → `/private/var` on macOS) and collapses the home to `~`. The adapter normalizes (expands `~` and resolves symlinks) every path it returns.
- **One connection per subscription:** a second `events.subscribe` request over the same connection makes herdr close it. The adapter opens one connection per subscription. If herdr rejects a subscription (an `error` response, e.g. a pane that no longer exists), it emits `subscription_failed` and does not retry.
- **Error codes used for idempotency:** `workspace_not_found` (`workspace close`, `worktree remove`), `pane_not_found`, `agent_not_found`, `agent_name_taken` (concurrent start with the same name), `agent_not_ready` (started blocked) and `timeout` (`agent wait`/`start`).
- **`worktree remove` on the project's workspace** (not a worktree) fails with `not_linked_worktree`.
- **Closing a workspace's last pane closes the workspace.**
- **A subscription with a nonexistent `pane_id`** is rejected entirely with `pane_not_found`, also when re‑subscribing after a loss. That is why one subscription per pane is advisable.
- **CLI timeouts:** the adapter kills the `herdr` process at 30 s (`cli_timeout`). Commands that wait get a 10 s margin over the `--timeout` passed to herdr; `agent wait` without a timeout has no limit.
- **`agent prompt`:** the text goes as a positional, even if it starts with `-`. Behind `--` herdr rejects it.
- **Real suite without Claude Code:** `pane report-agent` lets any process report itself as an agent. The suite uses a `claude` stub that enters the pane's PATH via `ZDOTDIR`, because macOS's login shell rewrites the inherited `PATH`. It requires zsh and is run with `pnpm --filter @lunasq/adapters test:herdr`.
