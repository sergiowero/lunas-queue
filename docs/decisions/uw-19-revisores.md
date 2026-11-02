# UW-19 — Reviewer subagents and recording of their executions

- Status: accepted
- Date: 2026-10-29
- Unit: UW-19 · Code: `assets/agents/lunasq/`, `packages/schemas/src/subagents.ts`, `packages/db/src/run-subagents.ts`, `packages/db/drizzle/0005_run_subagents.sql`, `packages/server/src/subagents/`, `packages/server/src/dispatcher/hook-settings.ts`

## Context

`docs/design.md` (§Verification with subagents) defines 4 read‑only reviewers on Opus, with compact output. It also asks that the `SubagentStart` and `SubagentStop` hooks tell LunasQ which subagents ran in each Run, because UW-23 rejects a verdict that reports a reviewer that does not appear in those hooks. UW-19's criterion: the 4 are launched from a test session and LunasQ records each execution. What remained to decide was how the hooks reach the agent's session, how they are authenticated and where they are stored.

## Spike result

With Claude Code 2.1.312, `claude -p --settings <file>` and a subagent in `<repo>/.claude/agents/lunasq/`:

- Claude Code discovers subagents inside a subdirectory of `agents/`. This confirms the design's `~/.claude/agents/lunasq/` path.
- A hook `type: "http"` with `headers: {"X-LunasQ-Run-Token": "$LUNASQ_RUN_TOKEN"}` and `allowedEnvVars: ["LUNASQ_RUN_TOKEN"]` arrives with the token expanded from the environment, in both `SubagentStart` and `SubagentStop`.
- The input carries `session_id`, `agent_id` and `agent_type` (the subagent's `name`). `SubagentStop` adds `agent_transcript_path` and `last_assistant_message`, among others.
- Without `CLAUDE_CODE_FORK_SUBAGENT=0`, the session launched the subagent in the background.

## Decision

- **Reviewers.** Four files in `assets/agents/lunasq/`, with file name equal to the `name` and to `REVIEWER_NAMES` from `@lunasq/schemas`. They carry `model: opus` and `tools: Read, Grep, Glob, Bash`: no Edit, Write, NotebookEdit or Agent.
  - Each one forbids writing, also through Bash, and leaves the test suite to the approver.
  - Bash is kept, as the design's reviewer table fixes: without it they cannot read `git diff` or `git log`. That is why "read‑only" is a guarantee of tools (there is no Edit or Write) and of prompt, not of sandbox. A reviewer with Bash could write to the worktree or call the LunasQ MCP with the `LUNASQ_RUN_TOKEN` it inherits from the pane. The test gate that LunasQ runs before accepting a pass and the human review of the PR bound it. The alternative, removing Bash and passing the diff in the prompt, was discarded for v1 because a large diff does not fit in the reviewer's context.
  - The output is one line per finding, `[<severity>] <file>:<line> · <criterion> · <evidence>`, or `NO FINDINGS`. The severities are those of the verification handoff's `Finding` (`critical`, `major`, `minor`), so the approver copies the fields without translating.
  - The code reviewer carries the test coherence checklist. In the reversal test it only points out which tests should fail, because reverting the code is done by the approver.
  - The browser MCP for UI and UX is not in v1: it depends on the project, and a project can override the reviewer in its `.claude/agents/`.
- **Hooks through a stable settings file.** `ensureHookSettings(path, url)` writes, like `ensureMcpConfig` (ADR 0002), a single file per installation with the two `http` hooks towards `POST /hooks/subagent`. The token goes as `$LUNASQ_RUN_TOKEN` and never touches disk. `agentArgs` adds `--settings <file>` in all phases, because an implementer can also launch subagents and recording them costs nothing. `--settings` becomes a reserved flag: a profile that brings it fails with `profile_conflict`. `Orchestrator` receives `hooks: {settingsPath, url}` and writes the file on startup.
- **`CLAUDE_CODE_FORK_SUBAGENT=0`.** It goes by default in each pane's environment, like `MCP_TOOL_TIMEOUT`, and `paneEnv` can override it.
- **Endpoint.** `POST /hooks/subagent` in `createApp`. First it looks up the active Run by the `X-LunasQ-Run-Token` header. With an absent, unknown or closed‑Run token, it answers `{}` with no effects and without validating the body. With an active Run, it validates the input with `SubagentHookInput`, which tolerates new Claude Code fields, and answers 400 if it is not a `SubagentStart` or `SubagentStop`. If the Run has a native session id (the dispatcher's `--session-id`), it ignores hooks with another `session_id`, so another `claude` that inherits the token leaves no evidence in the Run. It does not answer 401: a hook error does not stop Claude Code, but it clutters the agent's screen, and an old session has nothing to correct.
- **Recording.** The `run_subagents` table has one row per `(run_id, agent_id)`, with `agent_type`, `started_at`, `stopped_at` and `transcript_path`, and is deleted with its Run. It is a table and not an event because UW-23 queries it per Run and because hooks repeat or get lost: either one creates the row, the first of each fixes its time and repeating it changes nothing. The times are the server's, because the hooks' input carries no time.
- **Real test.** `pnpm --filter @lunasq/server test:claude` brings up the app on a local port, installs the reviewers in a temporary repo and opens `claude -p` with the settings and the token in the environment, as in a pane. Then it checks that the 4 were recorded with start, end and transcript. It uses `LUNASQ_REVIEWER_MODEL=haiku` by default so as not to spend Opus; with `opus` it tests the files as they are. It passed with both.

## Consequences

- **UW-23**: `submit_verdict` compares the `ran` reviewers with `RunSubagentRepository.forRun(runId)` by `agentType`. A reviewer with `started_at` but without `stopped_at` did not finish. The evidence is not unforgeable: whoever has the Run's token and session id (the session itself, or a subagent with Bash) can send hooks. It proves that the approver did not omit a reviewer by oversight, not that a malicious agent did not lie.
- **UW-24**: `transcript_path` points to each subagent's transcript, to convert it to markdown in the evidence.
- **UW-28**: `lunasq install` copies `assets/agents/lunasq/` to `~/.claude/agents/lunasq/` and sets the settings path and the endpoint URL that the `Orchestrator` receives. `doctor` can repeat the real test with haiku.
- **UW-18**: the `verify-task` skill launches the reviewers by name and does not put them in the background.
- The endpoint does not validate Host or Origin. Without an active token it has no effects, and the token has 256 bits.
- `--settings` is added to the user and project settings, it does not replace them. A user hook keeps running alongside LunasQ's.
