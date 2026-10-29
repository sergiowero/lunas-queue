export type GitHubErrorCode =
  /** `gh` no está instalado o no se pudo ejecutar. */
  | "gh_unavailable"
  /** `gh` sin sesión (exit 4). */
  | "not_authenticated"
  | "not_found"
  | "timeout"
  /** Salida que no cumple el esquema esperado. */
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
