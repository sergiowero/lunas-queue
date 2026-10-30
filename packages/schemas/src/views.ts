// Vistas de solo lectura que consume el front end (UW-21, ADR uw-21-front-end): Runs, Event log,
// usage, evidencia y la cola global. Se derivan de las tablas; ninguna se escribe por la API.
import { z } from "zod";
import { Actor, AgentKind, Phase, RunResult, SessionSource } from "./enums.ts";
import { Task } from "./task.ts";

/** Un Run como lo ve la UI: sin el run token, que solo vive en el pane del agente. */
export const RunView = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  phase: Phase,
  agentKind: AgentKind,
  model: z.string().nullable(),
  iteration: z.int().min(0),
  herdrWorkspace: z.string().nullable(),
  herdrPane: z.string().nullable(),
  herdrName: z.string().nullable(),
  agentSession: z.string().nullable(),
  agentSessionSource: SessionSource.nullable(),
  startedAt: z.date(),
  endedAt: z.date().nullable(),
  result: RunResult.nullable(),
  failureReason: z.string().nullable(),
  handoff: z.unknown(),
});
export type RunView = z.infer<typeof RunView>;

export const EventView = z.strictObject({
  id: z.int().min(1),
  taskId: z.uuid(),
  type: z.string(),
  actor: Actor,
  payload: z.unknown(),
  createdAt: z.date(),
});
export type EventView = z.infer<typeof EventView>;

const Tokens = z.int().min(0);

/** Suma de UsageRecords; costUsd es null mientras ningún registro trae costo. */
export const UsageTotals = z.strictObject({
  inputTokens: Tokens,
  outputTokens: Tokens,
  cacheReadTokens: Tokens,
  cacheWriteTokens: Tokens,
  costUsd: z.number().min(0).nullable(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

export const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
};

export const TaskUsage = z.strictObject({
  total: UsageTotals,
  byRun: z.array(z.strictObject({ runId: z.uuid(), phase: Phase, usage: UsageTotals })),
});
export type TaskUsage = z.infer<typeof TaskUsage>;

/** Archivo de evidencia `lunasq/tasks/{id}.md` del worktree (lo escribe UW-24). */
export const TaskEvidence = z.strictObject({ path: z.string().min(1), markdown: z.string() });
export type TaskEvidence = z.infer<typeof TaskEvidence>;

const queueBase = { task: Task, usage: UsageTotals };

/**
 * Una tarea viva en la cola global. Las del ready set traen el score del scheduler y van primero,
 * en su orden; las demás (corriendo, esperando dependencias o al humano) no tienen score.
 */
export const QueueEntry = z.discriminatedUnion("ready", [
  z.strictObject({
    ...queueBase,
    ready: z.literal(true),
    score: z.number(),
    effectivePriority: z.int().min(0),
  }),
  z.strictObject({
    ...queueBase,
    ready: z.literal(false),
    score: z.null(),
    effectivePriority: z.null(),
  }),
]);
export type QueueEntry = z.infer<typeof QueueEntry>;

export const QueueQuery = z.strictObject({ projectId: z.uuid().optional() });
export type QueueQuery = z.infer<typeof QueueQuery>;
