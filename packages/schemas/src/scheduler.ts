// Configuración del scheduler (docs/design.md §Scheduler, ADR 0014): límites de concurrencia
// global, por fase y por tipo de agente, y los pesos del score. El límite por proyecto vive en
// ProjectLimits.concurrency.
import { z } from "zod";
import { AgentKind, Phase } from "./enums.ts";

export const DEFAULT_GLOBAL_CONCURRENCY = 5;

const positiveInt = z.int().min(1);

/** Fases que el scheduler agenda: la entrega corre dentro del Run del verificador (ADR 0007). */
export const SchedulablePhase = Phase.exclude(["deliver"]);
export type SchedulablePhase = z.infer<typeof SchedulablePhase>;

export const SchedulerConfig = z.strictObject({
  // Agentes vivos en total.
  globalConcurrency: positiveInt.default(DEFAULT_GLOBAL_CONCURRENCY),
  phaseConcurrency: z.partialRecord(SchedulablePhase, positiveInt).default(() => ({})),
  agentKindConcurrency: z.partialRecord(AgentKind, positiveInt).default(() => ({})),
  // En las mismas unidades que la prioridad: puntos por hora en ready.
  agingPointsPerHour: z.number().min(0).default(10),
  // Puntos por cada tarea no terminal que la tarea bloquea, directa o transitivamente.
  boostPerDescendant: z.number().min(0).default(25),
  // Tick periódico: recoge el aging y los cambios que no pasan por el outbox. Mínimo 1 s para
  // que no se vuelva un bucle ocupado.
  tickIntervalMs: z.int().min(1000).default(30_000),
});
export type SchedulerConfig = z.infer<typeof SchedulerConfig>;
export type SchedulerConfigInput = z.input<typeof SchedulerConfig>;
