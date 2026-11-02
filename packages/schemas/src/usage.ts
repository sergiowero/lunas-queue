// OTLP/HTTP JSON telemetry from Claude Code to the usage collector (docs/design.md §Usage,
// ADR uw-20-usage-collector). Only what LunasQ reads from the logs is modeled: the rest is tolerated,
// because Claude Code adds attributes between versions.
import { z } from "zod";

export const OTLP_LOGS_PATH = "/v1/logs";
export const OTLP_METRICS_PATH = "/v1/metrics";

/** Resource attributes the dispatcher sets with `OTEL_RESOURCE_ATTRIBUTES` in each pane. */
export const RESOURCE_ATTRIBUTES = {
  taskId: "lunasq.task_id",
  runId: "lunasq.run_id",
  phase: "lunasq.phase",
} as const;

/** Claude Code event with the tokens and the cost of an API call. */
export const API_REQUEST_EVENT = "api_request";

// A value with an unexpected type is read as absent (`catch`) instead of rejecting the batch: the
// OTLP exporters do not retry a 400 and the usage of the other calls would be lost.
const AnyValue = z.looseObject({
  stringValue: z.string().optional().catch(undefined),
  // OTLP/JSON sends int64 as string; Claude Code sends them as a number.
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
