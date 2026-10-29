// Contrato entre el dispatcher, el pane del agente y el LunasQ MCP (ADR 0002, docs/tech-stack.md
// §Variables de entorno). El token solo vive en el entorno del pane; el archivo MCP lo referencia.

/** Header con el que Claude Code manda el run token en cada request al LunasQ MCP. */
export const RUN_TOKEN_HEADER = "X-LunasQ-Run-Token";

/** Variables que el dispatcher fija en el pane de cada Run. */
export const RUN_ENV = {
  runToken: "LUNASQ_RUN_TOKEN",
  taskId: "LUNASQ_TASK_ID",
  runId: "LUNASQ_RUN_ID",
  phase: "LUNASQ_PHASE",
} as const;
