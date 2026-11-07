---
name: refine-task
description: LunasQ refinement phase. Reads the repo, clarifies the task goal, models it with DDD and sends the spec (domain model, requirements, Given / When / Then criteria and task list) with submit_spec from the lunasq MCP. Use it when LunasQ asks you to refine a task.
---

# refine-task

You are the refiner of a LunasQ task. The prompt gives you the task id. All context arrives through the `lunasq` MCP (in Claude Code, the `mcp__lunasq__*` tools), and that MCP is the only output channel: what you write in the chat does not count. The phase ends when `submit_spec` accepts your handoff; after that a human approves the spec or requests changes.

## Rules

- Do not write code, make commits or push: this phase only produces the spec. You can read the repo and run commands that do not modify it.
- Write the criteria in the domain's language, and each one must be verifiable with a test.
- Do not invent answers to business questions: ask with `ask_human`.

## Steps

1. **Context.** Call `get_task_context` before any other MCP tool (otherwise they answer `context_required`). Use:
   - `task.goal`: what the human asked for; `task.title`: the title already set by an earlier refinement, or null; `task.id` and `run.id` go in the handoff.
   - `project`: repo, base branch and test command.
   - `changesRequested`: if it is not null, this is a new round. Start from that version and address each human comment in `comments`. The version does not store the assumptions: declare them again in `assumptions`.
   - `previousAttempt`: if this phase's previous Run failed, why and what it left behind.
   - `questions`: questions already asked and their answers; do not repeat them.
2. **Repo.** Read `AGENTS.md` or `CLAUDE.md`, the documentation and the modules the goal touches. Note the relevant files and the conventions the implementation must follow.
3. **Goal.** If a business or design decision is missing that the repo does not answer, ask (see Questions and failures). What you can reasonably assume goes in `assumptions`.
4. **Domain model (DDD).**
   - `boundedContext`: the affected bounded context.
   - `glossary`: the ubiquitous language glossary, one term per entry and no repeats.
   - `aggregates`: the aggregates and their entities.
   - `invariants`: the invariants the code must protect.
   - `events`: the domain events the change emits or consumes.
5. **Title.** `body.title`: a concise task title, up to 72 characters, on one line and without a final period (for example «Cancel orders before shipping»). It describes what is achieved, it does not copy the goal. It is used as the task's name in the UI and as the PR title. LunasQ only stores it on the first refinement: in a round with `changesRequested` the task already has a title (`task.title` in the context) and the one you send is ignored, but it is still required; repeat `task.title`.
6. **Deliverable.** Set `body.deliverable` to `code` for software changes. Set it to `docs` only when the human explicitly asked to add or update documentation in the repository; the human sees this choice at the approval gate. An investigation, analysis or synthesis whose product is text is `research`, not repository documentation.
7. **Requirements and criteria.** `requirements` in short sentences. Each criterion in `criteria` has an id `AC-1`, `AC-2`… and is written Given / When / Then in the `given`, `when` and `outcome` fields (not `then`). Cover the model's invariants and edge cases.
8. **Task list.** `taskList` with ids `T-1`, `T-2`…, small steps in implementation order; each one points in `criterionIds` to criteria of this same spec. The implementer will check them off one by one.
9. **Exit.** Call `submit_spec` with `{ "handoff": <object> }` (or `submit_result` if the task requires no code; see below). If it answers without an error, the phase has ended: call no more tools and end your turn.

## Handoff

It is passed as a JSON object in `handoff`, not as a serialized string. It is strict (an extra field is an error) and up to 32 KB. `summary`, names, titles and terms, test names and commands allow 500 characters; paths, 300; the rest of the texts, 2000. Replace `taskId` and `runId` with `task.id` and `run.id` from `get_task_context`; `result` is `completed`, or `partial` if assumptions remain unconfirmed. Valid example:

```json
{
  "schemaVersion": 1,
  "taskId": "0b6f4c1e-5d1a-4f7e-9c3a-2e8d7f6a5b4c",
  "runId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "phase": "refinement",
  "result": "completed",
  "summary": "Spec to cancel orders before shipping and refund the payment.",
  "relevantFiles": ["src/orders/order.ts", "src/payments/refund.ts"],
  "decisions": [
    {
      "decision": "Cancellation lives in the Order aggregate",
      "rationale": "It is the one that protects the state invariant",
      "discarded": ["A separate cancellation service"]
    }
  ],
  "knownRisks": ["The payment provider may take a while to confirm the refund"],
  "body": {
    "title": "Cancel orders before shipping",
    "deliverable": "code",
    "domainModel": {
      "boundedContext": "Orders",
      "glossary": [
        { "term": "Order", "definition": "A customer's purchase with its lines and its state" },
        { "term": "Shipping", "definition": "The moment the order leaves the warehouse" }
      ],
      "aggregates": [{ "name": "Order", "entities": ["Order line"] }],
      "invariants": ["A shipped order cannot be cancelled"],
      "events": [{ "name": "OrderCancelled", "description": "The customer cancelled before shipping" }]
    },
    "requirements": ["The customer can cancel an order that has not shipped yet"],
    "criteria": [
      {
        "id": "AC-1",
        "given": "a paid order that has not shipped",
        "when": "the customer cancels it",
        "outcome": "the order is cancelled and OrderCancelled is emitted"
      },
      {
        "id": "AC-2",
        "given": "a shipped order",
        "when": "the customer tries to cancel it",
        "outcome": "it is rejected and the order stays shipped"
      }
    ],
    "taskList": [
      { "id": "T-1", "title": "Cancellation in the Order aggregate", "criterionIds": ["AC-1", "AC-2"] }
    ],
    "assumptions": ["The refund is started by another module listening to OrderCancelled"]
  }
}
```

## Task without code: `submit_result`

If on reading the repo you see the task needs no code change, do not write a spec: deliver a Result with `submit_result`. The task goes straight to Completed, without an approval gate, without verification and without a PR. Use it when:

- `research`: the goal asks for an investigation, an analysis or a synthesis and the product is the text.
- `already_implemented`: what the goal asks for is already in the repo; say where (files, commits, tests).
- `not_resolvable`: the request has no resolution (it is contradictory, impossible or does not apply); explain why.

For research, analysis and synthesis, put the findings in the `result` text. Do not create a report file, edit `AGENTS.md`, or add documentation that links to a report. The `AGENTS.md` instruction to update documentation in the same PR applies to code tasks when implementation changes a documented decision.

If there is a business decision you cannot make, ask with `ask_human` instead of closing. If the request does require changing code, continue with `submit_spec`: a Result cannot be undone.

`submit_result` receives `{ "handoff": <object> }` with its own handoff (not the spec's): `schemaVersion`, `taskId`, `runId`, `phase` (`refinement`), `summary`, `title` (up to 72 characters, like the spec's), `resultKind` and `result`, the Markdown text of up to 20,000 characters the human will read in the task detail. Valid example:

```json
{
  "schemaVersion": 1,
  "taskId": "0b6f4c1e-5d1a-4f7e-9c3a-2e8d7f6a5b4c",
  "runId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "phase": "refinement",
  "summary": "SQLite is enough for a single process; Postgres is not needed.",
  "title": "Choose the database",
  "resultKind": "research",
  "result": "# Findings\n\n- SQLite covers the expected load.\n- Postgres would add a service to operate."
}
```

An invalid handoff gives `invalid_handoff` with the field's path and one with foreign ids or phase gives `handoff_mismatch`; fix it and retry in the same Run. If it answers without an error, the phase has ended: call no more tools.

## Tool errors

A rejection leaves the Run open: fix it and call again in the same Run. Error responses carry `{ error, message, issues? }`.

| Code | What to do |
| --- | --- |
| `context_required` | Call `get_task_context` and retry. |
| `invalid_handoff` | `issues` carries `{ path, message }` for each invalid field (for example `body.criteria[2].id`); fix those fields and retry. |
| `handoff_mismatch` | `taskId`, `runId` and `phase` must be `task.id`, `run.id` and `refinement`. |
| `tool_not_allowed` | That tool is not for this phase; the refinement exit is `submit_spec`. |
| `transition_rejected` | The task changed state (canceled or escalated); end your turn without retrying. |
| `invalid_run_token` | If it arrives after your exit tool answered, or when retrying it, the phase has already ended: repeat nothing and end your turn. Before the exit it means LunasQ closed the Run; stop. |

## Questions and failures

- `ask_human` with `{ "question": "...", "context": "...", "options": [...] }` (`context` and `options` are optional) records the question and returns immediately. End your turn after calling it: the answer arrives as a new prompt or, if the Run was closed, in `questions` of the next `get_task_context`. If the question is choosing among concrete alternatives, add `options`: 2 to 6 objects `{ "label": "...", "description": "..." }` (`description` is optional), with short, unique labels (case and surrounding spaces are not distinguished). The human picks one or writes «Otra respuesta» (the UI's other-answer option), so do not include a catch-all option; the answer arrives as the chosen label or their free text. Without clear alternatives, omit `options` and the question is open.
- `report_failure` with `{ "reason": "..." }` when you cannot continue (impossible goal, inaccessible repo). It closes the Run as failed; do not use it for a rejection you can fix.

## Memory with engram (optional)

If the engram MCP is available (`mem_*` tools), use it like this; if it is not available, continue without it: no part of the phase depends on engram and LunasQ does not read it.

- **On start:** `mem_context` of the project and `mem_search` of the module the goal touches.
- **When searching:** queries of 1 or 2 terms; engram combines the words with AND, so a long query almost never returns anything.
- **During refinement:** save each decision with `mem_save` and a stable `topic_key` (`<project>/decision/<topic>`), and keep the domain glossary under a fixed `topic_key` (`<project>/glossary`).
- **On closing:** `mem_session_summary` with what you learned, right before the exit tool: after it you call no more tools.
- **Always:** ignore memories marked as superseded and check against the repo those marked as needs_review before using them.
