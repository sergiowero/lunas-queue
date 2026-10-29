// Configuración del scheduler (docs/design.md §Scheduler, ADR 0014): límites de concurrencia
// global, por fase y por tipo de agente, y los pesos del score. El límite por proyecto vive en
// ProjectLimits.concurrency.
import { z } from "zod";
import { AgentKind, Phase } from "./enums.ts";

export const DEFAULT_GLOBAL_CONCURRENCY = 5;

const positiveInt = z.int().min(1);

export const SchedulerConfig = z.strictObject({
  // Agentes vivos en total.
  globalConcurrency: positiveInt.default(DEFAULT_GLOBAL_CONCURRENCY),
  phaseConcurrency: z.partialRecord(Phase, positiveInt).default(() => ({})),
  agentKindConcurrency: z.partialRecord(AgentKind, positiveInt).default(() => ({})),
  // En las mismas unidades que la prioridad: puntos por hora en ready.
  agingPointsPerHour: z.number().min(0).default(10),
  // Puntos por cada tarea no terminal que la tarea bloquea, directa o transitivamente.
  boostPerDescendant: z.number().min(0).default(25),
  // Tick periódico: recoge el aging y los cambios que no pasan por el outbox.
  tickIntervalMs: positiveInt.default(30_000),
});
export type SchedulerConfig = z.infer<typeof SchedulerConfig>;
export type SchedulerConfigInput = z.input<typeof SchedulerConfig>;
