// Test gate (docs/design.md §Engineering practices, ADR uw-11-gate-tests). LunasQ runs the
// project's test command in a herdr pane opened from the task's worktree, without
// environment credentials, and leaves each run in the Event log with `test_gate.executed`. What
// the agent says about its tests does not count: only this run's exit code.
import {
  type GitAdapter,
  type HerdrAdapter,
  HerdrPaneRunner,
  type ProcessResult,
  type ProcessRunner,
} from "@lunasq/adapters";
import { appendEvent, type LunasqDatabase } from "@lunasq/db";
import {
  TEST_GATE_EXECUTED,
  TEST_GATE_OUTPUT_LIMIT,
  TestGateExecutedPayload,
} from "@lunasq/schemas";
import {
  DEFAULT_GATE_TIMEOUT_MS,
  GATE_OUTPUT_LIMIT,
  type TestGate,
  type TestGateInput,
  type TestGateResult,
  tailOf,
} from "../mcp/ports.ts";
import type { EnsuredWorktree } from "../worktrees/service.ts";
import { stripAnsi } from "./ansi.ts";

/**
 * Pane variables that reach the suite; the rest (`GH_TOKEN`, API keys) do not. Just enough
 * to find the tools and write to the home and the tmpdir.
 */
export const GATE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
];

export interface PaneTestGateDeps {
  db: LunasqDatabase;
  git: Pick<GitAdapter, "resolveCommit">;
  /** Ensures the task's worktree (WorktreeService.ensure); the pane is opened from its root. */
  worktrees: { ensure(taskId: string): Promise<EnsuredWorktree> };
  /** HerdrPaneRunner over `herdr` by default. */
  runnerFor?: (parentPaneId: string) => ProcessRunner;
  herdr?: HerdrAdapter;
  timeoutMs?: number;
}

type Execution = {
  headSha: string | null;
  result: ProcessResult | null;
  error: string | null;
  durationMs: number;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class PaneTestGate implements TestGate {
  private readonly db: LunasqDatabase;
  private readonly git: Pick<GitAdapter, "resolveCommit">;
  private readonly worktrees: PaneTestGateDeps["worktrees"];
  private readonly runnerFor: (parentPaneId: string) => ProcessRunner;
  private readonly timeoutMs: number;

  constructor(deps: PaneTestGateDeps) {
    this.db = deps.db;
    this.git = deps.git;
    this.worktrees = deps.worktrees;
    const herdr = deps.herdr;
    this.runnerFor =
      deps.runnerFor ??
      ((parentPaneId) => {
        if (!herdr) throw new Error("PaneTestGate needs herdr or runnerFor");
        return new HerdrPaneRunner({ herdr, parentPaneId });
      });
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  }

  async run(input: TestGateInput): Promise<TestGateResult> {
    // An empty command counts as no command.
    const command = input.command?.trim() ? input.command : null;
    const execution = command
      ? await this.execute(input, command)
      : {
          headSha: null,
          result: null,
          error: "the project has no test command configured",
          durationMs: 0,
        };
    const { result, error } = execution;
    const passed = error === null && result !== null && result.exitCode === 0 && !result.timedOut;
    // No ANSI sequences: the Event log is meant to be read, not to reproduce colors.
    const output = stripAnsi(result ? `${result.stdout}${result.stderr}` : "");

    appendEvent(
      this.db,
      {
        taskId: input.taskId,
        type: TEST_GATE_EXECUTED,
        actor: "system",
        payload: TestGateExecutedPayload.parse({
          runId: input.runId,
          trigger: input.trigger,
          command,
          headSha: execution.headSha,
          exitCode: result?.exitCode ?? null,
          timedOut: result?.timedOut ?? false,
          durationMs: execution.durationMs,
          passed,
          output: tailOf(output, TEST_GATE_OUTPUT_LIMIT),
          error: error && stripAnsi(tailOf(error, 2000)),
        }),
      },
      { publish: true },
    );

    // The agent receives the tail of the output and, at the end, why there was no result.
    const notes = [result?.timedOut ? "the test gate exceeded its time limit" : null, error];
    const shown = notes.reduce<string>(
      (text, note) =>
        note === null ? text : `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${note}\n`,
      output,
    );
    return { passed, output: tailOf(shown, GATE_OUTPUT_LIMIT) };
  }

  private async execute(input: TestGateInput, command: string): Promise<Execution> {
    const started = Date.now();
    // The sha is evidence, not a condition: if it cannot be read, the suite runs anyway.
    const headSha = await this.git
      .resolveCommit({ cwd: input.worktreePath, ref: "HEAD" })
      .catch(() => null);
    try {
      // ensure is idempotent: with the worktree already ready it only returns its root pane.
      const worktree = await this.worktrees.ensure(input.taskId);
      if (worktree.path !== input.worktreePath) {
        throw new Error(`the task worktree is ${worktree.path}, not ${input.worktreePath}`);
      }
      const { rootPaneId } = worktree;
      const result = await this.runnerFor(rootPaneId).run({
        command,
        cwd: input.worktreePath,
        env: { CI: "1", LUNASQ_TASK_ID: input.taskId, LUNASQ_RUN_ID: input.runId },
        envAllowlist: GATE_ENV_ALLOWLIST,
        timeoutMs: this.timeoutMs,
      });
      return { headSha, result, error: null, durationMs: Date.now() - started };
    } catch (err) {
      return {
        headSha,
        result: null,
        error: `could not run the test gate: ${message(err)}`,
        durationMs: Date.now() - started,
      };
    }
  }
}

/** Gate of a server built without herdr (e.g. API only): no verification passes. */
export class UnavailableTestGate implements TestGate {
  async run(_input: TestGateInput): Promise<TestGateResult> {
    return { passed: false, output: "the test gate is not available on this server" };
  }
}
