// Telemetría OTLP/HTTP JSON de Claude Code hacia el usage collector (docs/design.md §Consumo,
// ADR uw-20-usage-collector). Solo se modela lo que LunasQ lee de los logs: el resto se tolera,
// porque Claude Code agrega atributos entre versiones.
import { z } from "zod";

export const OTLP_LOGS_PATH = "/v1/logs";
export const OTLP_METRICS_PATH = "/v1/metrics";

/** Atributos de recurso que el dispatcher fija con `OTEL_RESOURCE_ATTRIBUTES` en cada pane. */
export const RESOURCE_ATTRIBUTES = {
  taskId: "lunasq.task_id",
  runId: "lunasq.run_id",
  phase: "lunasq.phase",
} as const;

/** Evento de Claude Code con los tokens y el costo de una llamada a la API. */
export const API_REQUEST_EVENT = "api_request";

// Un valor con un tipo inesperado se lee como ausente (`catch`) en vez de rechazar el lote: los
// exportadores OTLP no reintentan un 400 y se perdería el consumo de las demás llamadas.
const AnyValue = z.looseObject({
  stringValue: z.string().optional().catch(undefined),
  // OTLP/JSON manda los int64 como string; Claude Code los manda como número.
  intValue: z.union([z.string(), z.number()]).optional().catch(undefined),
  doubleValue: z.number().optional().catch(undefined),
  boolValue: z.boolean().optional().catch(undefined),
});
export type AnyValue = z.infer<typeof AnyValue>;

const KeyValue = z.looseObject({ key: z.string(), value: AnyValue.optional() });
export type KeyValue = z.infer<typeof KeyValue>;

const attributes = z.array(KeyValue).default([]);

const LogRecord = z.looseObject({ body: AnyValue.optional(), attributes });
const ScopeLogs = z.looseObject({ logRecords: z.array(LogRecord).default([]) });
const ResourceLogs = z.looseObject({
  resource: z.looseObject({ attributes }).optional(),
  scopeLogs: z.array(ScopeLogs).default([]),
});

export const OtlpLogsRequest = z.looseObject({
  resourceLogs: z.array(ResourceLogs).default([]),
});
export type OtlpLogsRequest = z.infer<typeof OtlpLogsRequest>;
