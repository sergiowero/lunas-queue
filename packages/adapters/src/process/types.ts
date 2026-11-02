// Execution of project commands: worktree bootstrap, hooks and test gate.
// The rest of the system depends only on this interface; ShellProcessRunner, HerdrPaneRunner (in a
// herdr pane) and FakeProcessRunner implement it.

export interface ProcessInput {
  /** Shell line; it runs with `sh -c`. */
  command: string;
  cwd: string;
  /** Added to the LunasQ process env. */
  env?: Record<string, string>;
  /**
   * If present, the command does not inherit the full env: only these variables (those that are
   * defined) and those from `env`. This way credentials like `GH_TOKEN` do not reach it.
   */
  envAllowlist?: string[];
  /** No limit if omitted. */
  timeoutMs?: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessRunner {
  /** Does not throw on an exit code other than 0: the caller decides what counts as a failure. */
  run(input: ProcessInput): Promise<ProcessResult>;
}
