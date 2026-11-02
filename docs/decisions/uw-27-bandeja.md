# UW-27 — Inbox of approvals, questions and blocks

- Status: accepted; the specs-to-approve part is superseded by [ADR 0015](0015-bandeja-lista-de-specs.md)
- Date: 2026-10-30
- Unit: UW-27 · Code: `packages/web/src/pages/inbox.tsx`, `packages/web/src/lib/inbox.ts`, `packages/web/src/components/task/spec.tsx`, `packages/server/src/api/questions.ts` (`blockedRoutes`), `packages/server/src/runtime/runtime.ts`, `HerdrAdapter.focusAgent`

## Context

UW-27's criterion is that everything that waits for the human appears and is resolved from the Inbox. `docs/design.md` (§Spec approval, §Agent questions and blocks, §Front end: minimal views) asks for three things: specs to approve with their diff (approve, request changes or edit and approve), open Questions answered in the front end, and agents blocked by permission with an access that focuses their pane in herdr. ADR uw-22-preguntas left this unit to decide how the Inbox takes the user to the pane and whether `agent focus` is added to the adapter; ADR uw-21-front-end left edit and approve and the decision of mounting the notifications stream.

## Decision

- **One page, `/inbox`, with four sections**: «Specs por aprobar», «Tareas que necesitan atención», «Preguntas abiertas» and «Agentes bloqueados». Each pending item is an `article` with the task's intent (a link to the detail) and its project. The menu shows «Bandeja» with the total of pending items.
- **Specs to approve = tasks in `refined`.** They are derived from `GET /api/tasks`, with no new route: in `refined` the latest version is always pending, because approving or requesting changes takes the task out of that state. *Superseded by ADR 0015: the section is only a list of links to the task detail, where the gate lives (versions, content, diff and approve).*
- **Tasks that need attention = tasks in `needs_human`.** They are derived from `GET /api/tasks`, like the specs. Without this section, an escalated task (retries exhausted, verification loop exhausted, phase timeout, delivery failure) did not appear in the Inbox or in the counter. Each card links to the task detail.
- **Edit and approve** (`POST /api/tasks/:id/specs/:version/edit-and-approve`, UW-12) is added to the detail's gate (in the Inbox until ADR 0015). The content is edited as formatted JSON. The client only checks that it parses; `SpecContent` is validated by the server and the UI shows its issues (`path: message`). Validating on the client would pull zod into the bundle (ADR uw-21-front-end). A per‑field editor is left out of v1.
- **Errors.**
  - A failing query is shown in its section. «Nada espera por ti.» appears only with the three queries successful.
  - In the spec gate only the last action's error is shown: each action clears the error of the others.
  - A 409 from the gate does not refresh the panel, because refreshing it would unmount the gate together with the message. The change that caused the 409 arrives through `/api/stream`.
  - Answering a question or focusing a block does refresh the Inbox on an error, so the stale card does not stay active.
- **Questions**: `GET /api/questions?status=open` and `POST /api/questions/:id/answer` (UW-22). After answering, where the answer went is shown: to the live pane or to a new agent (`delivery`). The 409s (`not_open`, `task_not_waiting`) are shown as they are.
- **Access to a block's pane**:
  - `focusAgent(name)` is added to `HerdrAdapter` (`herdr agent focus <name>`, returns `agent_info`; `agent_not_found` if it does not exist), with a fake and a contract suite.
  - `POST /api/blocked/:runId/focus` only focuses agents that the `RunWatcher` sees as blocked. This way the UI cannot move herdr's view to an arbitrary agent. Responses: 204; 404 `not_blocked`; 409 `agent_gone` if herdr no longer has the agent; 502 `herdr_error` on any other failure; 503 `focus_unavailable` without herdr (`createApp({ focus })`).
  - The Inbox also shows the command `herdr agent focus <name>`, in case the UI runs on a different machine than the human's herdr.
  - The permission is answered in herdr. LunasQ does not answer it (ADR uw-22-preguntas).
- **Composition.** `startRuntime` did not pass `questions` or `blocked` to `createApp`, so on the real server answering gave 503 and the blocks list came out empty. Now it passes `orchestrator.questions`, `orchestrator.watcher.blocked()` and `herdr.focusAgent`.
- **Live updates.**
  - The changes stream (`/api/stream`) also invalidates `["questions"]` and `["blocked"]`: a new or answered question leaves events in the task's log.
  - The blocks live in the `RunWatcher`'s memory and leave no events. That is why the blocks query is refreshed every 5 s (`BLOCKED_REFRESH_MS`).
  - The UI does **not** mount the notifications stream (`/api/notifications/stream`, ADR 0009). It adds nothing to the Inbox: `question_open` and `agent_blocked` are emitted at 1 minute, when the question has already arrived through `/api/stream` and the block through the 5 s refresh. And it would cost a second SSE connection per tab: the server is HTTP/1.1 and the browser allows about 6 connections per host across all tabs. The alerts to the human still go out through herdr.

## Consequences

- A block takes up to 5 s to appear in or disappear from the Inbox. If immediacy were needed, the `RunWatcher` would have to publish its changes on a stream.
- Editing the spec as JSON requires knowing its shape. The server's validation errors guide the fix, but a structured editor would be friendlier; it is left for after the pilot (UW-29).
- `FakeApi` (`packages/web/test/fake-api.ts`) answers the routes for questions, blocks, focus and edit and approve, with the same rejections as the server. It validates the body with the `@lunasq/schemas` schemas (`QuestionAnswer`, `SpecEditAndApprove`, `SpecRequestChanges`) before looking up the entity, in the same order as the server, so the issues the tests see are the real ones.
