# 0006 — Handoff v1: Zod as the validator, JSON Schema as the structural contract

- Status: accepted
- Date: 2026-10-28
- Unit: UW-03 · Code: `packages/schemas/src/handoff/`, examples in `packages/schemas/examples/handoff/v1/`, JSON Schema in `packages/schemas/json-schema/v1/`

## Context

`docs/design.md` (Handoff format) asks for a common envelope plus a body per phase, validated against a versioned JSON Schema generated from Zod v4. Several handoff rules cross fields (unique ids, a pass without failing criteria, a reject with must‑fix, bounded total size), and `z.toJSONSchema` does not export `superRefine`.

## Decision

- **Zod is the validator.** `parseHandoff(input)` from `@lunasq/schemas` is the only gate: it reads `schemaVersion`, rejects unregistered versions, measures the size (≤ 32 KB in UTF‑8) and validates with that version's schema. The LunasQ MCP (UW-15) uses it directly.
- **The JSON Schema is a structural contract.** `pnpm --filter @lunasq/schemas generate` writes `handoff.json` (union by `phase`) and one file per phase; each declares draft 2020‑12, an `$id` `urn:lunasq:handoff:v1:<name>` and, in `description`, that the cross‑field rules are only applied by Zod. A drift test fails if the versioned file does not match Zod.
- **Errors** as `{ path, message }[]`, with paths like `body.criteria[2].id` (`(root)` for the whole object) and messages in English: Zod's default ones and the hand‑written messages of the custom rules.
- **Format:** strict objects (an unknown field is an error), identifiers in English camelCase, `result` `completed | partial` (a failure goes through `report_failure`, with no handoff), criteria `AC-<n>` with `given / when / outcome` (`then` is avoided because it makes the object "thenable"), `requirements` mandatory in refinement (the Spec stores them), tasks `T-<n>`, `riskLabel` `low | medium | high` (shown as low / medium / high in the UI and PR), the 4 `lunasq-*-reviewer` reviewers mandatory with `ran` + findings or `skipped` + justification; each must‑fix and each refuted finding carries `source` (the reviewer that originated it or `approver`) for the audit.
- **Versions:** `handoffSchemas` registers each version; an incompatible change adds `2` without deleting `1`, and the examples and the JSON Schema live per version.
- **Boundaries:** the tests and the generator of `schemas` use `node:fs`; Biome exempts them from the import rule, and in `src` it also forbids Node globals (`process`, `Buffer`, `require`, `global`, `__dirname`, `__filename`, `setImmediate`). The package compiles with `types: ["node"]` so tests and script typecheck: the `src` boundary is guaranteed by Biome, not tsc, because the matrix in `tooling/boundaries.test.ts` does not allow a separate tsconfig for tests.

## Consequences

- A consumer that validates only with the JSON Schema accepts handoffs that Zod rejects; LunasQ must never validate that way.
- UW-15 validates the handoff's criteria against the approved spec (e.g. that `criterionTests` covers all its criteria): the schema does not know the spec.
- UW-18 and `assets/agents` must use the same reviewer names.
- The schema does not require each serious finding of a reviewer to appear in `mustFix` or `refuted`: comparing findings requires identity between them and is left for UW-15/UW-18 if needed.
- There is no JSON Schema validator (ajv) in the repo; nothing checks that the generated JSON Schema accepts the examples, only that it matches Zod.
- The retry handoff (Questions, checklist, summary of the failed Run) is built by LunasQ, not by an agent; it has no schema here.
