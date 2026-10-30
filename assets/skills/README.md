# assets/skills

Skills de fase de LunasQ, una carpeta con `SKILL.md` por fase que despacha el dispatcher: `refine-task` (DDD, sale por `submit_spec`), `implement-task` (TDD, sale por `submit_for_verification`) y `verify-task` (approver con los 4 revisores, sale por `submit_verdict`). La entrega no tiene skill: la hace LunasQ ([ADR uw-18-skills-fase](../../docs/decisions/uw-18-skills-fase.md)). `lunasq install` (UW-28) las copia a `~/.claude/skills/`.

Cada skill trae un handoff de ejemplo en su primer bloque `json`; `packages/server/src/skills/examples.test.ts` lo valida con `parseHandoff`. La prueba con Claude Code real es `pnpm --filter @lunasq/server test:skills`.
