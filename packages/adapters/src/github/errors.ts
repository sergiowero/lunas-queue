export type GitHubErrorCode =
  /** `gh` is not installed or could not be run. */
  | "gh_unavailable"
  /** `gh` without a session (exit 4). */
  | "not_authenticated"
  | "not_found"
  | "timeout"
  /** Output that does not meet the expected schema. */
  | "invalid_output"
  | "gh_failed";

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;

  constructor(code: GitHubErrorCode, message: string, options?: ErrorOptions) {
    super(`gh ${code}: ${message}`, options);
    this.name = "GitHubError";
    this.code = code;
  }
}

export function isGitHubError(err: unknown, code?: GitHubErrorCode): err is GitHubError {
  return err instanceof GitHubError && (code === undefined || err.code === code);
}
