// Contract between the dispatcher, the agent pane and the LunasQ MCP (ADR 0002, docs/tech-stack.md
// §Environment variables). The token only lives in the pane's environment; the MCP file references it.

/** Header with which Claude Code sends the run token on each request to the LunasQ MCP. */
export const RUN_TOKEN_HEADER = "X-LunasQ-Run-Token";

/** Variables the dispatcher sets in the pane of each Run. */
export const RUN_ENV = {
  runToken: "LUNASQ_RUN_TOKEN",
  taskId: "LUNASQ_TASK_ID",
  runId: "LUNASQ_RUN_ID",
  phase: "LUNASQ_PHASE",
} as const;
