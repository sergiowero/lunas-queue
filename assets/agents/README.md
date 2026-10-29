# assets/agents

Los 4 subagentes revisores de la fase de verificación, en `lunasq/` (docs/design.md §Verificación con subagentes, [ADR uw-19-revisores](../../docs/decisions/uw-19-revisores.md)). `lunasq install` (UW-28) los copia a `~/.claude/agents/lunasq/`; un proyecto puede sobrescribir uno con un archivo del mismo nombre en su `.claude/agents/`.

Son de solo lectura (`tools: Read, Grep, Glob, Bash`), corren en Opus y responden una línea por hallazgo. LunasQ registra cada ejecución con los hooks `SubagentStart` y `SubagentStop`.
