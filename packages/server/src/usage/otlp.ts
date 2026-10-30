// Normaliza los logs OTLP de Claude Code a UsageInput (ADR uw-20-usage-collector). La fuente es el
// evento `api_request`: trae tokens, costo, `request_id` y `agent_id` por llamada. Las métricas
// `claude_code.token.usage` y `claude_code.cost.usage` son delta y no traen request id, así que
// reenviar un lote las duplicaría; no se usan.
import type { UsageInput } from "@lunasq/db";
import {
  API_REQUEST_EVENT,
  type KeyValue,
  type OtlpLogsRequest,
  RESOURCE_ATTRIBUTES,
} from "@lunasq/schemas";

type Attributes = Map<string, KeyValue["value"]>;

function attributesOf(...lists: KeyValue[][]): Attributes {
  const map: Attributes = new Map();
  for (const list of lists) for (const { key, value } of list) map.set(key, value);
  return map;
}

function text(attrs: Attributes, key: string): string | null {
  const value = attrs.get(key)?.stringValue;
  return value ? value : null;
}

/** Entero no negativo; ausente vale 0 y un valor inválido da null para descartar la llamada. */
function count(attrs: Attributes, key: string): number | null {
  const value = attrs.get(key);
  if (value === undefined) return 0;
  const raw = value.intValue ?? value.doubleValue;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Id estable de la llamada. Sin `request_id` se usa la secuencia del evento dentro de la sesión:
 * un `source_ref` NULL no deduplica en SQLite y un lote reenviado se contaría dos veces.
 */
function sourceRef(attrs: Attributes): string | null {
  const requestId = text(attrs, "request_id");
  if (requestId) return requestId;
  const session = text(attrs, "session.id");
  const seq = count(attrs, "event.sequence");
  return session && attrs.has("event.sequence") && seq !== null ? `${session}#${seq}` : null;
}

function cost(attrs: Attributes): number | null {
  const n = attrs.get("cost_usd")?.doubleValue ?? attrs.get("cost_usd")?.intValue;
  const value = typeof n === "string" ? Number(n) : n;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export type ApiRequestUsage = {
  /** `lunasq.run_id` que declaró el pane; el collector lo contrasta con el Run del token. */
  runId: string | null;
  sessionId: string | null;
  usage: UsageInput;
};

/** Las llamadas a la API del lote. Una llamada mal formada se descarta sin tumbar el resto. */
export function apiRequests(request: OtlpLogsRequest): ApiRequestUsage[] {
  const found: ApiRequestUsage[] = [];
  for (const resourceLogs of request.resourceLogs) {
    const resource = resourceLogs.resource?.attributes ?? [];
    for (const scope of resourceLogs.scopeLogs) {
      for (const record of scope.logRecords) {
        const attrs = attributesOf(resource, record.attributes);
        if (text(attrs, "event.name") !== API_REQUEST_EVENT) continue;
        const model = text(attrs, "model");
        const inputTokens = count(attrs, "input_tokens");
        const outputTokens = count(attrs, "output_tokens");
        const cacheReadTokens = count(attrs, "cache_read_tokens");
        const cacheWriteTokens = count(attrs, "cache_creation_tokens");
        if (
          model === null ||
          inputTokens === null ||
          outputTokens === null ||
          cacheReadTokens === null ||
          cacheWriteTokens === null
        ) {
          continue;
        }
        found.push({
          runId: text(attrs, RESOURCE_ATTRIBUTES.runId),
          sessionId: text(attrs, "session.id"),
          usage: {
            model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            costUsd: cost(attrs),
            source: "otel",
            sourceRef: sourceRef(attrs),
            agentId: text(attrs, "agent_id"),
          },
        });
      }
    }
  }
  return found;
}
