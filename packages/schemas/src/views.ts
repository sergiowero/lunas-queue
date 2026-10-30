// Vistas de solo lectura que consume el front end (UW-21, ADR uw-21-front-end): Runs, Event log,
// usage, evidencia y la cola global. Se derivan de las tablas; ninguna se escribe por la API.
import { z } from "zod";
import {
  Actor,
  AgentKind,
  Phase,
  PrState,
  RunResult,
  SessionSource,
  SubState,
  TaskState,
} from "./enums.ts";
import { Priority, Task } from "./task.ts";

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

/**
 * Archivo de evidencia `lunasq/tasks/{id}.md` (lo escribe UW-24): del worktree mientras existe; si
 * ya se limpió, de la branch de la tarea y, tras el merge, de la rama base. `path` es la ruta en
 * disco o `<ref>:<ruta>` en git.
 */
export const EvidenceSource = z.enum(["worktree", "branch", "base"]);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

export const TaskEvidence = z.strictObject({
  source: EvidenceSource,
  path: z.string().min(1),
  markdown: z.string(),
});
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

/** Una tarea del DAG: lo justo para dibujar el nodo y llevar a su detalle. */
export const TaskGraphNode = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  intent: z.string(),
  state: TaskState,
  subState: SubState.nullable(),
  prState: PrState.nullable(),
  priority: Priority,
});
export type TaskGraphNode = z.infer<typeof TaskGraphNode>;

/** `taskId` depende de `dependsOnId`: la flecha del DAG va de `dependsOnId` a `taskId`. */
export const TaskGraphEdge = z.strictObject({ taskId: z.uuid(), dependsOnId: z.uuid() });
export type TaskGraphEdge = z.infer<typeof TaskGraphEdge>;

/**
 * Las aristas reales de task_dependencies. Con `projectId`, las tareas del proyecto más las de
 * otros proyectos al otro extremo de una arista suya (dependencias entre proyectos); sin él,
 * todas. Todo extremo de una arista aparece entre los nodos.
 */
export const TaskGraph = z.strictObject({
  nodes: z.array(TaskGraphNode),
  edges: z.array(TaskGraphEdge),
});
export type TaskGraph = z.infer<typeof TaskGraph>;

export const TaskGraphQuery = z.strictObject({ projectId: z.uuid().optional() });
export type TaskGraphQuery = z.infer<typeof TaskGraphQuery>;
