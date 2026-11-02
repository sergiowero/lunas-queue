# UW-22 — Agent questions and permission blocks

- Status: accepted
- Date: 2026-10-29
- Unit: UW-22 · Code: `packages/server/src/questions/` (`QuestionService`, `QuestionEscalations`), `packages/server/src/api/questions.ts`, `packages/db/src/questions.ts` (`QuestionRepository`), `packages/schemas/src/question.ts`, `packages/domain/src/dispatch.ts` (`answerPrompt`), `RunWatcher.blocked()`

## Context

`docs/design.md` (§Agent questions and blocks) fixes the `ask_human` flow: the Question is stored, the task moves to `waiting_human` and the timeout is paused; the human answers in the Inbox; the answer reaches the live pane with `agent prompt` or, if the agent is no longer there, a new Run through `get_task_context`. ADR uw-15-mcp-tools left the answer to this unit; ADR uw-17-reconciliacion left open the Run of a task in `waiting_human` and ADR 0009 the 1‑minute notice.

## Decision

- **One open question per task.** `ask_human` already rejects a second one with the task in `waiting_human`, so `QuestionRepository.openForTask` returns at most one.
- **Answering is a transaction.** `QuestionRepository.answer` applies `answer` (actor `human`, `waiting_human` → `running` or `queued`), marks the Question as `answered` with `answeredBy`/`answeredAt` and appends the `question.answered` event (`delivery: pane | new_run`). A question that is no longer open answers `not_open`; a task that left `waiting_human`, `task_not_waiting`. Nothing is written on a rejection. `answeredBy` is `human` if the client does not send it: v1 is a single user.
- **Delivery, in this order** (`QuestionService.answer`, a lock per question):
  1. It is checked that the Run that asked is still open and that `getAgent(herdrName)` returns the same `paneId` that the Run stored. An agent with the same name in another pane does not receive the answer.
  2. `answerPrompt` is sent with `promptAgent`: question and answer on a single line, with the phase's skill so it closes with its exit tool. If herdr fails, the agent is considered lost.
  3. The transaction is confirmed with `agentAlive` according to the previous step. The prompt goes before the transition: if herdr rejects it, the answer is not lost and continues through the new Run. The window between the prompt and `running` is milliseconds, much less than the agent takes to call an exit tool.
  4. Without a live agent, `dispatcher.closeRun(..., cancelled, "question_answered: …")` closes the old Run and its pane immediately and wakes the scheduler. This way the new Run's claim does not collide with `run_active` and does not wait for the reconciler, which would close the Run of a task outside its phase anyway (ADR uw-17-reconciliacion).
  - The new Run receives the Question with its answer in `get_task_context` (`questions`), with no changes to the MCP.
- **Notice at 1 minute** (`QuestionEscalations`). On seeing the transition to `waiting_human` in the outbox, it arms `Escalator.watch` with id `question:<questionId>`, kind `question_open` and `since` equal to the Question's creation. Answering, canceling the task or leaving `waiting_human` call `resolve`. On startup, `rearm` arms again the deadline of each open question from the database (the clock lives in memory, ADR 0009) and cancels those that no longer correspond to a task in `waiting_human`.
- **Cancellation.** If the task leaves `waiting_human` without an answer (cancellation, needs_human), its open questions become `cancelled` with the `question.cancelled` event and the cause (`task_cancelled` or `left_waiting_human`).
- **Phase timeout.** No change from ADR uw-17-reconciliacion: the `PhaseClock` pauses in `waiting_human` and resumes on answering, so an answer hours later does not expire the phase. UW-22 covers it with end‑to‑end tests.
- **API.** `GET /api/questions` (filters `status`, `taskId`, `projectId`; oldest first), `GET /api/questions/:id` and `POST /api/questions/:id/answer` (`{ answer, answeredBy? }` → `{ question, delivery }`; 404, 409 for `not_open` and `task_not_waiting`, 503 without a service). `createApp` receives `questions` (the orchestrator's `QuestionService`); whoever composes the server connects it.
- **Events to the UI.** The question appears in the Inbox immediately through the query (`GET /api/questions?status=open`), which the UI refreshes with the transitions; the notifications SSE (ADR 0009) carries the `question_open` notice at 1 minute. There is no separate questions stream.
- **Permission blocks.** The notice at 1 minute and the timeout pause are already done by the `RunWatcher` (ADR uw-17-reconciliacion). This unit adds `RunWatcher.blocked()` and `GET /api/blocked` (`createApp({ blocked })`), which list the blocked agents with their pane. They are answered in herdr: LunasQ does not answer permissions.

## Structured options (task 21)

- **Contract.** `ask_human` accepts an optional `options`: 2 to 6 `{ label, description? }`. `label` of 1 to 100 trimmed characters, `description` of up to 500; labels are unique ignoring case and surrounding whitespace. An invalid entry is rejected in input validation, before touching the database: no Question is created and the task's state does not change. Without `options` the Question is open.
- **Persistence.** Nullable JSON column `questions.options` (migration 0012); earlier Questions stay `null`. The options do not change after being created. `GET /api/questions`, `GET /api/questions/:id` and `get_task_context`'s `questions` return them (`options: null` if there are none).
- **Answer.** Does not change: `POST /api/questions/:id/answer` still receives `answer` as text. With an option it is its `label`; with «Otra respuesta», the trimmed free text. The server does not require the answer to be one of the options, because «Otra respuesta» is valid.
- **Inbox.** A question with options is shown as a `fieldset` with radios (label and description of each option) and an «Otra respuesta» radio that enables a text field. Answering is enabled with a chosen option or with «Otra respuesta» and non‑empty text; switching to an option sends its label, not the text. Without options the text field is kept.
- **Skills.** The phase skills explain when to send `options` (concrete alternatives) and that a catch‑all option is not needed.

## Consequences

- herdr's adapter has no `agent focus`; UW-27 decides how the Inbox takes the user to the pane (with the `paneId` from `/api/blocked`) and whether it is added to the adapter.
- A duplicate outbox response or a double click does not resend the prompt: the per‑question lock and `not_open` prevent it.
- If the process crashes between the prompt and the transaction's confirmation, the question stays open and the human can answer again; the agent would receive two answers. It is accepted in v1.
- Not tested against real Claude Code: that the TUI accepts a one‑line prompt while `idle` after `ask_human`'s turn ends. It is the same mechanism as the nudge; the pilot (UW-29) calibrates it.
- UW-21 and UW-27 consume these endpoints and the notifications SSE.
