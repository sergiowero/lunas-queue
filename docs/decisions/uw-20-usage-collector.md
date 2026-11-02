# UW-20 — Usage collector: OTLP receiver and Task.usage

- Status: accepted
- Date: 2026-10-30
- Unit: UW-20 · Code: `packages/server/src/usage/`, `packages/schemas/src/usage.ts`, `packages/db/src/usage.ts`, `packages/db/drizzle/0006_usage_agent_id.sql`, `telemetryRunEnv` in `packages/domain/src/dispatch.ts`

## Context

`docs/design.md` (§Consumption) asks each task to show tokens and cost as a read‑only property, aggregated from the UsageRecords of its Runs, with a breakdown by phase, agent, model and reviewer. UW-28 already left the general OTLP variables in the pane and `UsageRecord` already existed in the database (ADR 0005); what was missing were the endpoints, the per‑Run attributes and the breakdowns. UW-20's criterion: a task's usage matches what Claude Code reports.

## Spike result

With Claude Code 2.1.314 and a local `http/json` receiver:

- The attributes from `OTEL_RESOURCE_ATTRIBUTES` arrive in each batch's resource and in the attributes of each log and each metric point.
- The metrics `claude_code.token.usage` and `claude_code.cost.usage` are **delta** (`aggregationTemporality: 1`) and carry no request id.
- The `api_request` log carries per call `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd` and `request_id`; according to Claude Code's documentation also `agent_id` if a subagent made it (v2.1.310 or later). `agent.name` of a custom subagent is `custom`, so it does not serve to tell reviewers apart.
- Tokens arrive as numeric `intValue` and cost as `doubleValue`.

## Decision

- **Source: the `api_request` event.** Each call is a UsageRecord with `source = otel` and `source_ref = request_id`. If Claude Code resends a batch, the unique index `(run_id, source, source_ref)` (ADR 0005) absorbs it. The metrics are discarded: they are delta and without a request id, so resending them would duplicate consumption and there is no way to deduplicate them. `POST /v1/metrics` exists so the exporter receives 200, and it does nothing.
- **Authentication by run token.** The dispatcher adds to the pane `OTEL_EXPORTER_OTLP_HEADERS=X-LunasQ-Run-Token=<token>` and `OTEL_RESOURCE_ATTRIBUTES=lunasq.task_id=…,lunasq.run_id=…,lunasq.phase=…` (`telemetryRunEnv`). The Run comes from the token, not from the attribute: the `lunasq.run_id` attribute is only cross‑checked. A record that declares another Run is discarded, and with a native session id so is one from another session, like the subagent hooks (ADR uw-19-revisores). An absent or unknown token answers `{}` with 200, because the exporter retries whatever is not 2xx; a body that is not OTLP answers 400.
- **Body limits.** The token is validated before reading the body. The received body has a cap of 8 MB (413) and the decompressed gzip one of 32 MB (400), so a POST without a token or a zip bomb do not exhaust the memory of the process that dispatches the agents. An attribute value with an unexpected type is read as absent instead of rejecting the batch, because OTLP exporters do not retry a 400.
- **Without `request_id`.** A NULL `source_ref` does not deduplicate in SQLite; if it is missing, `<session.id>#<event.sequence>` is used.
- **Closed Runs.** The token is looked up with `RunRepository.byToken`, which includes closed Runs: Claude Code flushes its buffer on exit and the last batch arrives after the exit tool closed the Run.
- **Reviewers by `agent_id`.** `usage_records.agent_id` (migration 0006, `ADD COLUMN` without recreating tables) stores the subagent that made the call. The per‑reviewer breakdown joins `usage_records` with `run_subagents` by `(run_id, agent_id)` (ADR uw-19-revisores) and is limited to `REVIEWER_NAMES`. The join is on read, so it does not matter whether the `SubagentStart` hook arrived before or after the log. Calls from an unknown `agent_id` (lost hook) count in the total and not in a reviewer.
- **Task.usage.** `GET /api/tasks/:id/usage` returns, in addition to `total` and `byRun`, `byPhase`, `byAgent`, `byModel` and `byReviewer`. In `byPhase`, rework is the implementation of a verification iteration later than the first (`runs.iteration > 0`). Groups without records do not appear. Cost is only summed when all the group's records carry it (ADR uw-21-front-end).
- **Feature flag.** `telemetry` in `~/.lunasq/config.json` (ADR uw-28-instalador) governs the whole usage collector. With `false`, the panes receive no OTEL variables (neither the general ones nor the per‑Run ones), `createApp` does not mount `/v1/logs` or `/v1/metrics` and Claude Code receives 404. It stays on by default. The UsageRecords already stored remain visible.
- **Real test.** `pnpm --filter @lunasq/server test:usage` opens `claude -p --output-format json` with a pane's environment and compares the stored tokens and cost with the `usage` and `total_cost_usd` that Claude Code reports. It passed with Claude Code 2.1.314. The normal tests use a real sanitized batch (`packages/server/src/usage/fixtures/`).

## Consequences

- **Out of scope.** Reconciliation against the transcript when closing the Run and the versioned price table (`source = transcript | calculated`, `pricing_version`) are left for when an agent that does not report cost exists (Codex, v2). `costUsd` is the Claude Code client's estimate, not the invoice (`docs/design.md` §Limitations).
- **UW-21.** The usage panel can show the new breakdowns; today it only uses `total` and `byRun`.
- **UW-23 and UW-24.** Per‑reviewer consumption is already available in case verification or the evidence wants to cite it.
- **UW-28.** `doctor` can already warn if `telemetry` is off; the message is still valid.
- A closed Run accepts records while it keeps its token and session; it can only inflate its own Run. It is not limited by a time window.
- The endpoint does not validate Host or Origin: without a valid Run token it has no effects, and the token has 256 bits.
