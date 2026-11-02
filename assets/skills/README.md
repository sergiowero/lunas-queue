# assets/skills

LunasQ phase skills, one folder with a `SKILL.md` per phase the dispatcher launches: `refine-task` (DDD, exits through `submit_spec`), `implement-task` (TDD, exits through `submit_for_verification`; both can close a task without code with `submit_result`) and `verify-task` (approver that chooses which of the 4 reviewers to launch, exits through `submit_verdict`). Delivery has no skill: LunasQ does it ([ADR uw-18-skills-fase](../../docs/decisions/uw-18-skills-fase.md)). `lunasq install` (UW-28) copies them to `~/.claude/skills/`.

Each skill carries an example handoff in its first `json` block; `packages/server/src/skills/examples.test.ts` validates it with `parseHandoff`. The test with real Claude Code is `pnpm --filter @lunasq/server test:skills`.
