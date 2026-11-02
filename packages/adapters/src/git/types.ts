// Git adapter: what LunasQ reads from the base branch and the commit of the changes the
// hooks leave. The rest of the system depends only on this interface; RealGit and FakeGit pass the same
// contract suite. Worktrees are handled by herdr (ADR 0012).

export interface GitFile {
  /** Name of the file inside the listed directory. */
  name: string;
  /** Mode 100755 in the commit. */
  executable: boolean;
}

export interface GitCommitInfo {
  sha: string;
  /** Full message, with trailers. */
  message: string;
  /** First line of the message. */
  subject: string;
  /** Author date: the rebase does not change it, so it places the commit in time. */
  authoredAt: Date;
}

export type RebaseResult =
  /** The branch already contained `onto`: nothing was touched. */
  | { status: "up_to_date"; head: string }
  | { status: "rebased"; head: string }
  /** A commit clashed with the base. The rebase is aborted: the worktree stays at the previous HEAD. */
  | { status: "conflict"; files: string[] };

export interface GitAdapter {
  /**
   * Fetches `<branch>` from `<remote>` (updates `<remote>/<branch>`) and returns the sha it has on
   * the remote, without re-reading the local ref, which another checkout of the repo could move.
   */
  fetch(input: { cwd: string; remote: string; branch: string }): Promise<string>;
  /** Sha of the commit `ref` points to; `ref_not_found` if it does not exist. */
  resolveCommit(input: { cwd: string; ref: string }): Promise<string>;
  /**
   * Regular files directly inside `dir` at commit `commit`, without entering
   * subdirectories. Symlinks and submodules do not count. Without the directory, `[]`. It never looks at the
   * working tree.
   */
  listFiles(input: { cwd: string; commit: string; dir: string }): Promise<GitFile[]>;
  /** Content of `path` at commit `commit`; undefined if it does not exist or is not a file. */
  readFile(input: { cwd: string; commit: string; path: string }): Promise<Buffer | undefined>;
  /**
   * true if the working tree has uncommitted changes, including untracked files. Ignores
   * `lunasq/tasks/`: there LunasQ leaves the evidence file uncommitted (ADR
   * uw-24-archivo-evidencia).
   */
  isDirty(cwd: string): Promise<boolean>;
  /**
   * `add -A` and commit with the trailers (`Key: value`). Returns the sha, or null if there were no
   * changes: repeating it does not create empty commits. It does not include `lunasq/tasks/`; that is committed by
   * `commitPaths`.
   */
  commitAll(input: {
    cwd: string;
    message: string;
    trailers: Record<string, string>;
  }): Promise<string | null>;
  /**
   * Commit only `paths` (relative to the worktree, also if they are ignored), with the trailers.
   * Anything else in the index or the working tree stays as it was. Returns the sha, or null
   * if those paths had no changes.
   */
  commitPaths(input: {
    cwd: string;
    paths: string[];
    message: string;
    trailers: Record<string, string>;
  }): Promise<string | null>;
  /**
   * Rebase of the worktree's branch onto `onto` (e.g. `origin/main`). On conflicts it aborts and
   * returns the conflicting files; a failure that is not a conflict (dirty worktree, nonexistent
   * ref) throws `git_failed`.
   */
  rebase(input: { cwd: string; onto: string }): Promise<RebaseResult>;
  /** Commits of `base..HEAD`, from oldest to newest. */
  listCommits(input: { cwd: string; base: string }): Promise<GitCommitInfo[]>;
  /**
   * Adds trailers to commits of `base..HEAD` (key: current sha) rewriting them with their author and
   * date; descendants change sha. A trailer whose key the commit already carries is not repeated,
   * so repeating it changes nothing. Returns the new HEAD's sha.
   */
  addTrailers(input: {
    cwd: string;
    base: string;
    trailers: Record<string, Record<string, string>>;
  }): Promise<string>;
  /**
   * Publishes HEAD as `<remote>/<branch>` with `--force-with-lease`: after a rebase the history
   * changes, but it does not overwrite someone else's push. Throws `git_failed` if the remote rejects it.
   */
  push(input: { cwd: string; remote: string; branch: string }): Promise<void>;
  /** Temporary checkout at a detached HEAD at `commit`, linked to the repo of `cwd`. */
  addDetachedWorktree(input: { cwd: string; path: string; commit: string }): Promise<void>;
  /** Deletes the linked checkout `path`, with or without changes. Idempotent. */
  removeWorktree(input: { cwd: string; path: string }): Promise<void>;
}
