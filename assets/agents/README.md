# assets/agents

The 4 reviewer subagents of the verification phase, in `lunasq/` (docs/design.md §Verification with subagents, [ADR uw-19-revisores](../../docs/decisions/uw-19-revisores.md)). `lunasq install` (UW-28) copies them to `~/.claude/agents/lunasq/`; a project can override one with a file of the same name in its `.claude/agents/`.

They are read-only (`tools: Read, Grep, Glob, Bash`), run on Opus and answer one line per finding. LunasQ records each execution with the `SubagentStart` and `SubagentStop` hooks.
