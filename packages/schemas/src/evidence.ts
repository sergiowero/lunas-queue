// Archivo de evidencia de la tarea (docs/design.md §Auditoría, ADR uw-24-archivo-evidencia). Vive
// en el repo del proyecto, dentro del worktree de la tarea, y LunasQ lo escribe sin commitear.

/** Directorio del repo con un archivo de evidencia por tarea. */
export const EVIDENCE_DIR = "lunasq/tasks";

/** Ruta del archivo de evidencia de la tarea, relativa a la raíz del worktree. */
export const evidencePath = (taskId: string) => `${EVIDENCE_DIR}/${taskId}.md`;

/** Trailers de git que ligan cada commit de LunasQ con su tarea y su Run (docs/design.md §Auditoría). */
export const COMMIT_TRAILER_TASK = "LunasQ-Task";
export const COMMIT_TRAILER_RUN = "LunasQ-Run";
