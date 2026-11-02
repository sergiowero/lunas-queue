# ADR 0016: agent provider adapters

## Status

Accepted

## Context

The dispatcher must run Claude Code and GitHub Copilot CLI without mixing one provider's flags, MCP or telemetry with another's. Projects can select a provider per phase. Claude Code emits OTLP usage and HTTP subagent hooks; Copilot CLI does not offer those same signals in the current integration.

## Decision

- The explicit providers validated by the schema are Claude Code and Copilot CLI; a registry in `adapters` declares their capabilities and composes provider‑specific arguments.
- The primary configuration is per phase. The fallback tries each registered provider once, in order starting with the primary, only when the process cannot start or become ready before receiving the prompt. The failures of all providers are kept as Run events and escalate the task to `needs_human`.
- `lunasq install` maintains a `lunasq` entry in `~/.copilot/mcp-config.json`, preserving the other options and servers. Each Copilot Run uses a temporary MCP file with restrictive permissions containing its token; it is deleted after the CLI starts.
- Copilot CLI always runs in autopilot mode: the adapter adds `--autopilot` to every phase session and `CopilotCliReviewerExecutor` adds it to the reviewers. `--autopilot`, `--mode` and `--plan` (also as `--flag=value`) are reserved and a profile that brings them in `args` is rejected. The `--` terminator is not accepted in Copilot's `args` either, because it would turn the fixed flags, including `--autopilot`, into positionals. Claude's arguments do not change.
- Unsupported usage data is not invented: the UI identifies Copilot Runs without metrics and marks the recorded totals as partial.
- Verification with HTTP reviewers and the evidence hooks remain Claude‑only. Copilot's verification must not be presented as on par until reviewers/evidence are connected to the same guards.

## Consequences

- `domain` keeps phase rules agnostic; the flags and capabilities live in `adapters`.
- If a provider is added, it requires an enum/schema, an adapter and tests; loading arbitrary plugins is not allowed.
- Adding Copilot reviewers requires a hook integration compatible with the Run's identity and tests proving that the guards reject missing evidence.
