# OpenCode as a first-class agent provider

**Status:** accepted · **Date:** Nov 23, 2026

## Context

LunasQ supports Claude Code, GitHub Copilot CLI and Codex CLI as per-phase agent providers ([ADR 0016](0016-proveedores-agente.md), [ADR codex-provider](codex-provider.md)). [OpenCode](https://opencode.ai) is supported by herdr (`agent start --kind opencode`) and can be driven the same way, but it needs its own command-line flags, MCP authentication, permission model, reviewer execution and usage handling. A machine may not have it installed, so it must be possible to disable it without affecting the other providers.

Validated against OpenCode 1.19.6.

## Decision

- **Provider kind.** `opencode` joins the shared `AgentKind` enum, the `runs.agent_kind` CHECK (migration `0020_agent_kind_opencode.sql`, which rebuilds `runs` and preserves every Run and usage record) and the registry, after Codex (order: claude, copilot, codex, opencode). The global Settings toggle covers it, enabled by default also for settings saved before it existed (the Zod default fills the missing key).
- **Launch.** The dispatcher starts the interactive TUI through herdr's `--kind opencode`. The provider composes `--model <provider/model>` from the profile model and then the profile's own args. It never passes `--auto` (blanket auto-approval) and never `--pure`, so the user's own OpenCode settings and plugins keep working.
- **Reserved flags.** A profile model of kind `opencode` is rejected on save (`400 invalid_input`, path `[models, i, args]`, naming the flag) if its args carry `--model`/`-m`, `--auto`, `--port`, `--hostname`, `--mdns`, `--mdns-domain`, `--continue`/`-c`, `--session`/`-s`, `--fork`, `--prompt`, `--agent`, `--pure`, `--variant`, in either `--flag value` or `--flag=value` form, or the `--` terminator (it would turn the fixed flags into positionals).
- **Effort.** OpenCode's TUI has no flag for the model variant (`--variant` is documented only for `opencode run`). The profile's effort is therefore delivered as the default `variant` of the `build` agent in the inline config, together with that agent's `model` set to the same model, because OpenCode applies an agent's variant only to the agent's own model. It is the model variant OpenCode documents as provider-specific reasoning effort (`high`, `max`, `minimal`, …); which values exist depends on the model.
- **Per-Run configuration.** The dispatcher puts an inline config in the pane's environment as `OPENCODE_CONFIG_CONTENT`, next to `LUNASQ_RUN_TOKEN`:
  - the remote LunasQ MCP server (`mcp.lunasq`, `type: "remote"`) with the header `X-LunasQ-Run-Token: {env:LUNASQ_RUN_TOKEN}`, which OpenCode resolves from the environment. The token is never in argv, in the config content or in any persistent or global OpenCode file;
  - permissions that allow edits and commands without prompting (`edit: allow`, `bash: allow`, the LunasQ MCP tools allowed) and deny external directories (`external_directory: deny`), so the agent can only work inside its worktree.
- **Start screens.** OpenCode has no known startup prompt LunasQ accepts, so none is accepted: a fresh OpenCode agent that starts `blocked` gets no keys. The start fails as `agent_blocked` for that model (recorded as a failed provider attempt) and the profile's next model is tried; with no model left the task escalates with `providers_unavailable` as for any other provider. A reused (resumed) agent that is blocked is left under human control, as for every provider.
- **Model failure fallback.** The watcher's detection of usage limits, exits and stops without signal is provider-independent, so an OpenCode Run closes as `model_failed` with `run.model_fallback` and the task returns to `queued` for the profile's next model.
- **Verification.** OpenCode can be the verification provider. `run_reviewer` on an opencode Run goes through `OpencodeCliReviewerExecutor`, which runs `opencode run --pure --format json [--model <Run's model>]` in the worktree with the prompt from a private `0600` file on stdin and the event stream in another private file (directory `0700`, under `~/.lunasq/opencode-reviewers/<run>/`). The report is the text of the final assistant message in the JSON stream; the transcript archived as evidence is a private JSONL with the instructions and that report. The reviewer start and stop are recorded in the Run like Copilot's and Codex's. A reviewer that exits non-zero, times out (5 minutes) or produces no report returns an error naming the reviewer and the cause and records nothing; an id that is not a safe file name is rejected before any file is written or process run.
- **Reviewers are read-only.** The executor passes its own inline config: every permission denied by default, `read`/`grep`/`glob`/`list` allowed, `edit` denied, `bash` denied entirely (OpenCode matches bash rules per simple command and ignores redirections, so no pattern allowlist can stop `{ git log; } > file`; the reviewer reads with `read`/`grep`/`glob`/`list` and the approver includes the diff in its instructions), `OPENCODE_DISABLE_PROJECT_CONFIG=1` so the worktree's own `opencode.json` and `.opencode/` cannot widen the permissions or start MCP servers, external directories, web fetch and web search denied, and no MCP server (the reviewer never sees the run token). `--pure` skips external plugins. The process inherits only an environment allowlist.
- **Usage is not invented.** OpenCode does not report usage to LunasQ. A Run without a usage record is shown without metrics and the totals are marked as partial.
- **Evidence.** The evidence archive titles an OpenCode Run's session «OpenCode session».
- **Doctor.** `lunasq doctor` runs `opencode --version` and requires 1.19.6 or newer. Missing or old OpenCode is a warning when another provider is available (and also counts as an available provider for skipping Claude's herdr integration check). `lunasq install` does not write OpenCode's global configuration and does not require it.
- **UI.** The profile form offers OpenCode as a provider and Settings shows its toggle; the texts are in both ES and EN dictionaries.

## Consequences

- The `runs.agent_kind` CHECK is widened by a table rebuild; foreign keys are switched off for it and usage records keep their ids.
- The OpenCode inline config format (`mcp`, `permission`, `agent.<name>.variant`) is the one validated with OpenCode 1.19.6; a future OpenCode that renames these keys needs the config builder in `packages/adapters/src/agents/opencode-config.ts` updated, which is the single place that knows it.
- No npm dependency or OpenCode-specific global asset is added. OpenCode behavior stays behind the provider registry, the CLI doctor, the herdr terminal adapter and the reviewer executor.
- Because the effort rides on the `build` agent, an OpenCode profile that selects another agent through `args` is not possible (`--agent` is reserved).

## References

- [OpenCode CLI](https://opencode.ai/docs/cli)
- [OpenCode config](https://opencode.ai/docs/config) and [permissions](https://opencode.ai/docs/permissions)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers)

- **Usage limits.** The watcher recognizes OpenCode's own notices on its screen (`Free usage exceeded, subscribe to Go`, `Usage limit reached. It will reset in …`, `Rate limit exceeded`, validated against OpenCode 1.19.6) and the provider errors it relays (`rate_limit_error`, `insufficient_quota`) with `OPENCODE_USAGE_LIMIT_PATTERN`, applied only to OpenCode Runs; the Run then falls back to the next model like any other usage limit.
