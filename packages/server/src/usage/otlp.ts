// Normalizes Claude Code's OTLP logs to UsageInput (ADR uw-20-usage-collector). The source is the
// `api_request` event: it carries tokens, cost, `request_id` and `agent_id` per call. The
// `claude_code.token.usage` and `claude_code.cost.usage` metrics are delta and carry no request id, so
// resending a batch would duplicate them; they are not used.
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

/** Non-negative integer; absent is 0 and an invalid value gives null to discard the call. */
function count(attrs: Attributes, key: string): number | null {
  const value = attrs.get(key);
  if (value === undefined) return 0;
  const raw = value.intValue ?? value.doubleValue;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Stable id of the call. Without `request_id` the event's sequence within the session is used:
 * a NULL `source_ref` does not deduplicate in SQLite and a resent batch would be counted twice.
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
  /** `lunasq.run_id` declared by the pane; the collector checks it against the token's Run. */
  runId: string | null;
  sessionId: string | null;
  usage: UsageInput;
};

/** The batch's API calls. A malformed call is discarded without taking down the rest. */
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
