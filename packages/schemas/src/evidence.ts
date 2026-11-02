// Task evidence file (docs/design.md §Audit, ADR uw-24-archivo-evidencia). It lives
// in the project repo, inside the task worktree, and LunasQ writes it without committing.

/** Repo directory with one evidence file per task. */
export const EVIDENCE_DIR = "lunasq/tasks";

/** Path of the task's evidence file, relative to the worktree root. */
export const evidencePath = (taskId: string) => `${EVIDENCE_DIR}/${taskId}.md`;

/** Git trailers that link each LunasQ commit to its task and its Run (docs/design.md §Audit). */
export const COMMIT_TRAILER_TASK = "LunasQ-Task";
export const COMMIT_TRAILER_RUN = "LunasQ-Run";
