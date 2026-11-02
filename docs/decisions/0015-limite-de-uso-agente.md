# ADR — Agent usage limit: screen detection and needs_human

- Status: accepted
- Date: 2026-10-30
- Code: `packages/adapters/src/herdr/claude-tui.ts` (`showsUsageLimit`, `usageLimitMessage`), `packages/schemas/src/events.ts` (`EscalationReason.usage_limit`), `packages/schemas/src/notification.ts` (kind `usage_limit`), `packages/server/src/reconciler/watcher.ts` (`usageLimit`, `escalateUsageLimit`, `checkBlocked`)

## Context

When Claude Code reaches its usage limit, its TUI draws the notice and the turn ends: herdr sees it as `idle`/`done` (prompt box) or `blocked` if it draws the `/rate-limit-options` menu (its detection manifest has no rule for that UI). Until now LunasQ treated that stop like any `idle/done`: nudges that restart the agent to hit the limit again, and when they run out a Run failed by `agent_stopped` that consumes retries on the same condition. And `herdr agent read` already exists: it was the way to recognize the trust dialog (ADR 0004 and uw-16).

Forms of the notice seen (the CLI's claude.ai docs, October 2026):

- `Usage limit reached · limit resets 3:45pm` with footer `Continuing automatically at 3:45pm · Esc to cancel` (auto‑continue, v2.1.234+).
- `Usage limit reached · wrapping up`; old messages `5-hour limit reached · resets <time>` and `You've reached your weekly limit. It resets <day> at <time>`.
- `Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again`.

## Decision

- **Claude's text is recognized in `adapters`** (`showsUsageLimit`, `usageLimitMessage` next to the trust dialog), and the screen reading lives in the watcher: in the stopped‑agent path (`idle`/`done` past the grace period) and in the `blocked` path (a block came in that may be the limit menu, not a permission; it is read before the minute's blocked‑agent notice matures).
- **It is not a Run failure:** it is a human pause. The watcher applies `escalate` with the new reason `usage_limit` and `expected` in `running`, with the text Claude drew as the note, and notifies immediately (id `usage:<runId>` and kind `usage_limit`, like the phase timeout: the outbox's `escalationNotification` does not repeat it). The Run and the agent stay as they are — if Claude's automatic wait continues, the human decides in herdr.
- The usual `resume` leaves `needs_human`: it closes the old Run and redispatches the phase with the same worktree (the timeout's mechanics). Like the timeout, the clock stays stopped: no nudges or timeout while the task waits.
- False positives accepted and bounded: the pattern requires CLI phrases (`usage limit reached`, `usage-limit`, `limit resets <time>`, etc.) and the screen is only read on a phase stop; if the agent's own work mentions limits with those exact forms, the escalation is recoverable in one click (resume) and the notification shows the text that triggered it.

## Consequences

- When Claude ends the turn because of the limit, LunasQ does not burn nudges or retries: the task stays in `needs_human` with the analysis state on screen.
- Detection depends on the TUI: if Claude changes its texts, `USAGE_LIMIT_PATTERN` in adapters must be updated; the `herdr agent read` spikes are the way to capture them.
- Test against real herdr/Claude pending for the pilot (complements the clock and nudge pending items in [uw-17](uw-17-reconciliacion.md)).
