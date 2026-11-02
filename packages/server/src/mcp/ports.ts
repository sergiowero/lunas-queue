// LunasQ MCP ports toward the worktree: the test gate, the commit check and the
// phase hooks. The gate runs in a herdr pane and leaves its result in the Event log
// (test-gate/, UW-11); the commit check runs git commands with adapters' ProcessRunner;
// the hooks are run by HookService (hooks/, UW-10).
import type { ProcessRunner } from "@lunasq/adapters";
import {
  EVIDENCE_DIR,
  type HookPoint,
  type HookPointOutcome,
  type TestGateTrigger,
} from "@lunasq/schemas";

export type TestGateInput = {
  taskId: string;
  runId: string;
  worktreePath: string;
  /** Project test command; without it there is no green gate. */
  command: string | null;
  /** What the gate asked for; it stays in the `test_gate.executed` event. */
  trigger: TestGateTrigger;
};

export type TestGateResult = {
  passed: boolean;
  /** Tail of the combined output, so the agent knows what to fix. */
  output: string;
};

export interface TestGate {
  run(input: TestGateInput): Promise<TestGateResult>;
}

export type CommitCheckInput = {
  worktreePath: string;
  baseBranch: string;
  commits: string[];
};

export interface CommitVerifier {
  /** Handoff commits that are not in the task's branch (or that are already in the base). */
  missing(input: CommitCheckInput): Promise<string[]>;
  /** Files with uncommitted changes: the gate must run on what is committed. */
  uncommitted(worktreePath: string): Promise<string[]>;
  /**
   * true if the task's branch has commits that are not in the base branch (neither local nor
   * `origin/<base>`). If it cannot be checked it answers true: submit_result must not complete a
   * task that may have code.
   */
  branchHasCommits(input: { worktreePath: string; baseBranch: string }): Promise<boolean>;
  /** Sha of the worktree's HEAD; null if it cannot be read. */
  head(worktreePath: string): Promise<string | null>;
  /**
   * true if `to` descends from `from` and the intermediate commits only touch the evidence file
   * (`lunasq/tasks/`). The pass uses it to tolerate the commits LunasQ or an agent makes of the
   * evidence after the `submit_for_verification` gate.
   */
  onlyEvidenceBetween(input: { worktreePath: string; from: string; to: string }): Promise<boolean>;
}

export type PhaseHookInput = {
  taskId: string;
  point: HookPoint;
  runId: string;
  /** Result of the phase for the `after_*` hooks (e.g. the verdict). */
  phaseResult?: string | null;
  /** PR URL, in the hooks that run when it already exists (`after_delivery`). */
  prUrl?: string | null;
};

export type PhaseHookResult = {
  outcome: HookPointOutcome;
  /** The task went to needs_human with `hook_failed`. */
  escalated: boolean;
  failedScript: string | null;
  error: string | null;
};

/** Hooks of a phase point; HookService implements it. */
export interface PhaseHooks {
  run(input: PhaseHookInput): Promise<PhaseHookResult>;
}

/** Without composed hooks: each point passes without running anything, like a project without `lunasq/hooks/`. */
export class NoPhaseHooks implements PhaseHooks {
  async run(_input: PhaseHookInput): Promise<PhaseHookResult> {
    return { outcome: "passed", escalated: false, failedScript: null, error: null };
  }
}

export const GATE_OUTPUT_LIMIT = 4000;

/** Default gate time limit: a hung suite must not run forever. */
export const DEFAULT_GATE_TIMEOUT_MS = 20 * 60_000;

/** The end of the output, which is where the error is. */
export const tailOf = (text: string, limit: number) =>
  text.length > limit ? text.slice(text.length - limit) : text;

/** POSIX shell quotes: the value arrives as a single literal argument. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export class GitCommitVerifier implements CommitVerifier {
  readonly #runner: ProcessRunner;

  constructor(runner: ProcessRunner) {
    this.#runner = runner;
  }

  async missing(input: CommitCheckInput): Promise<string[]> {
    const missing: string[] = [];
    for (const sha of input.commits) {
      // The SHA already comes validated as hexadecimal by the handoff schema; --end-of-options
      // keeps a base branch like `--foo` from being read as a git option. The worktree comes from
      // origin/<base> (ADR 0012) and the local base may be behind: a commit that is already in
      // either of the two is not the task's.
      const remote = `origin/${input.baseBranch}`;
      const result = await this.#runner.run({
        command: [
          `git rev-parse --verify --quiet --end-of-options ${quote(`${input.baseBranch}^{commit}`)} >/dev/null`,
          `git merge-base --is-ancestor --end-of-options ${quote(sha)} HEAD`,
          `! git merge-base --is-ancestor --end-of-options ${quote(sha)} ${quote(input.baseBranch)}`,
          `{ ! git rev-parse --verify --quiet --end-of-options ${quote(`${remote}^{commit}`)} >/dev/null || ! git merge-base --is-ancestor --end-of-options ${quote(sha)} ${quote(remote)}; }`,
        ].join(" && "),
        cwd: input.worktreePath,
      });
      if (result.exitCode !== 0) missing.push(sha);
    }
    return missing;
  }

  async branchHasCommits(input: { worktreePath: string; baseBranch: string }): Promise<boolean> {
    const result = await this.#runner.run({
      // Commits reachable from HEAD that are in neither of the base's two refs: the
      // worktree comes from origin/<base> (ADR 0012) and the local base may be behind or ahead.
      command: [
        'refs=""',
        `for ref in ${quote(`origin/${input.baseBranch}`)} ${quote(input.baseBranch)}; do git rev-parse --verify --quiet --end-of-options "$ref^{commit}" >/dev/null && refs="$refs $ref"; done`,
        '[ -n "$refs" ]',
        "git rev-list --count HEAD --not --end-of-options $refs",
      ].join("; "),
      cwd: input.worktreePath,
    });
    if (result.exitCode !== 0) return true;
    return Number.parseInt(result.stdout.trim(), 10) !== 0;
  }

  async head(worktreePath: string): Promise<string | null> {
    const result = await this.#runner.run({
      command: "git rev-parse --verify --quiet HEAD^{commit}",
      cwd: worktreePath,
    });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async uncommitted(worktreePath: string): Promise<string[]> {
    const result = await this.#runner.run({
      // lunasq/tasks/ is LunasQ's evidence file, which is committed on delivery.
      command: `git status --porcelain --untracked-files=all -- . ${quote(`:(exclude)${EVIDENCE_DIR}`)}`,
      cwd: worktreePath,
    });
    if (result.exitCode !== 0) return ["(git status failed)"];
    return result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(3));
  }

  async onlyEvidenceBetween(input: {
    worktreePath: string;
    from: string;
    to: string;
  }): Promise<boolean> {
    const result = await this.#runner.run({
      // `--name-only -z` separates paths with NUL: a name with line breaks is not confused
      // with two paths.
      command: [
        `git merge-base --is-ancestor --end-of-options ${quote(input.from)} ${quote(input.to)}`,
        `git diff --name-only --no-renames -z --end-of-options ${quote(input.from)} ${quote(input.to)} --`,
      ].join(" && "),
      cwd: input.worktreePath,
    });
    if (result.exitCode !== 0) return false;
    return result.stdout
      .split("\0")
      .filter((path) => path !== "")
      .every((path) => path.startsWith(`${EVIDENCE_DIR}/`));
  }
}
