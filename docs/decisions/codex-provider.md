# Codex CLI as a first-class agent provider

**Status:** accepted · **Date:** Nov 2, 2026

## Context

LunasQ already supports Claude Code and GitHub Copilot CLI as per-project, per-phase agent providers. Codex CLI is supported by herdr, but needs provider-specific command-line flags, MCP authentication, folder trust handling, reviewer execution and usage reporting. A machine may not have Codex installed, so users need to be able to disable it without making the other providers unavailable.

## Decision

- Add `codex` to the shared `AgentKind` enum and use the existing global Settings provider toggle. Codex is enabled by default for new and existing saved settings; the human can disable it when unavailable. The scheduler falls back through the provider registry order (Claude, Copilot, Codex), with the configured phase provider first.
- Launch the interactive Codex TUI through herdr's `--kind codex`. Pass model and reasoning effort as per-process arguments, and use `--sandbox workspace-write` with `--ask-for-approval never`; never pass the full-access bypass option. Reject user args that override those settings or MCP configuration.
- Configure the LunasQ HTTP MCP server with Codex `--config` overrides for each Run. The URL is quoted as a TOML string, the `X-LunasQ-Run-Token` header reads from `LUNASQ_RUN_TOKEN`, and `default_tools_approval_mode="approve"` prevents unattended LunasQ MCP calls from asking in the TUI; the token itself is never put in argv or a persistent/global Codex config file. The approval override is scoped only to this authenticated, per-Run LunasQ server.
- Accept Codex's directory-trust screen only when its expected trust text and both choices are present. This trusts the LunasQ worktree for the agent; other blocked prompts remain under human control.
- Support Codex as a verification provider. Its reviewer executor invokes `codex exec` with `--sandbox read-only`, `--ignore-user-config` and `--config approval_policy="never"`, sends the prompt through a private file on stdin, stores a private transcript, and records the reviewer start/stop in the Run. Claude retains native subagents; Copilot and Codex use LunasQ-managed CLI reviewer executors.
- Do not infer or fabricate Codex token usage. The UI reports consumption as partial when a Codex Run has no usage record.
- `lunasq doctor` checks Codex CLI 0.122.0 or newer; an unavailable/old provider is a warning when another provider is available. `lunasq install` does not edit Codex's global configuration.

## Consequences

- The SQLite `runs.agent_kind` CHECK is expanded by migration `0014_agent_kind_codex.sql`; the migration preserves Run identifiers and usage records. The Settings schema default keeps databases with older saved provider objects readable.
- Codex profiles may select a model and reasoning effort, but supported effort values depend on that Codex model. Codex's native reviewer hooks and usage reporting are not required for parity with LunasQ's verification gates.
- No npm dependency or Codex-specific global asset is added. Codex behavior stays behind the existing provider registry, CLI doctor, and herdr terminal adapter. The reviewer executor ignores Codex user/project configuration to prevent unrelated MCP servers or hooks from expanding its permissions.

## References

- [Herdr agent automation](https://herdr.dev/docs/agent-automation)
- [OpenAI Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [OpenAI Codex configuration reference](https://developers.openai.com/codex/config-file/config-reference)