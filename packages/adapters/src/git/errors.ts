export type GitErrorCode =
  /** `git` is not installed or the cwd does not exist. */
  "git_unavailable" | "ref_not_found" | "timeout" | "git_failed";

export class GitError extends Error {
  readonly code: GitErrorCode;

  constructor(code: GitErrorCode, message: string, options?: ErrorOptions) {
    super(`git ${code}: ${message}`, options);
    this.name = "GitError";
    this.code = code;
  }
}

export function isGitError(err: unknown, code?: GitErrorCode): err is GitError {
  return err instanceof GitError && (code === undefined || err.code === code);
}
