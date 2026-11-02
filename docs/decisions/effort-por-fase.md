# Agent effort per phase

**Status:** accepted

## Context

Each phase's agent profile already had `model` and `args`. Claude Code's effort (`claude --effort`) could only be passed inside `args`, as free text, without validation and without help in the form.

## Decision

- `AgentProfile` gains `effort?: low | medium | high | xhigh | max` (`EffortLevel` in `packages/schemas/src/project.ts`). It applies to all four phases, including `verify`, which shares the same profile.
- `agentArgs` (packages/domain/src/dispatch.ts) emits `--effort <level>` right after `--model`, before the profile's args.
- A profile with `effort` and also `--effort` (or `--effort=…`) in `args` is rejected with `DispatchRuleError`: there are no two sources for the same flag.
- The project form has an «Esfuerzo de {fase}» selector with «Predeterminado» (no `effort`).

`--effort` is not reserved globally: projects that already put it in `args` keep working.

## Consequences

- Without `effort`, the `claude` command is identical to before.
- When editing a project, removing the effort in the selector removes it from the profile (the PATCH replaces the whole profile).
