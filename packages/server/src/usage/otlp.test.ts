import { readFileSync } from "node:fs";
import { OtlpLogsRequest } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { apiRequests } from "./otlp.ts";

const real = OtlpLogsRequest.parse(
  JSON.parse(
    readFileSync(new URL("fixtures/claude-2.1.314-api-request.json", import.meta.url), "utf8"),
  ),
);

const attr = (key: string, value: object) => ({ key, value });
const str = (key: string, v: string) => attr(key, { stringValue: v });
const request = (attributes: object[], event = "api_request") => ({
  body: { stringValue: `claude_code.${event}` },
  attributes: [str("event.name", event), ...attributes],
});
const batch = (records: object[], resource: object[] = []) =>
  OtlpLogsRequest.parse({
    resourceLogs: [{ resource: { attributes: resource }, scopeLogs: [{ logRecords: records }] }],
  });

describe("apiRequests", () => {
  it("lee tokens, costo, request id y atributos del Run de un lote real de Claude Code 2.1.314", () => {
    const found = apiRequests(real);
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({
      runId: "R1",
      sessionId: "97892113-54cc-4ec7-8a96-b604a5ba5434",
      usage: {
        model: "claude-haiku-5-5",
        inputTokens: 2,
        outputTokens: 289,
        cacheReadTokens: 0,
        cacheWriteTokens: 28702,
        costUsd: 0.0058851,
        source: "otel",
        sourceRef: "req_011CgYr8fYMtghfjfKGoxvBc",
        agentId: null,
      },
    });
    expect(found[1]?.usage).toMatchObject({
      outputTokens: 16,
      cacheReadTokens: 28702,
      cacheWriteTokens: 363,
      sourceRef: "req_011CgYr8qtwtiGBoQSzAyHu3",
    });
  });

  it("sin request_id deriva un source_ref estable de la sesión y la secuencia del evento", () => {
    const withSequence = (n: number) =>
      request([
        str("model", "m"),
        str("session.id", "s-1"),
        attr("event.sequence", { intValue: n }),
      ]);
    const [a, b] = apiRequests(batch([withSequence(7), withSequence(7)]));
    expect(a?.usage.sourceRef).toBe("s-1#7");
    expect(b?.usage.sourceRef).toBe(a?.usage.sourceRef);
    const [none] = apiRequests(batch([request([str("model", "m")])]));
    expect(none?.usage.sourceRef).toBeNull();
  });

  it("ignora los eventos que no son api_request", () => {
    expect(apiRequests(batch([request([], "tool_result"), request([], "api_error")]))).toEqual([]);
  });

  it("toma agent_id del subagente y acepta int64 como string", () => {
    const [found] = apiRequests(
      batch([
        request([
          str("model", "claude-opus-5-5"),
          str("request_id", "req_1"),
          str("agent_id", "a3f2c1b4d5e6f7a80"),
          attr("input_tokens", { intValue: "12" }),
          attr("output_tokens", { intValue: 3 }),
        ]),
      ]),
    );
    expect(found?.usage).toMatchObject({
      agentId: "a3f2c1b4d5e6f7a80",
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 0,
      costUsd: null,
    });
  });

  it("los atributos del evento ganan a los del recurso", () => {
    const found = apiRequests(
      batch(
        [request([str("lunasq.run_id", "R2"), str("model", "m")])],
        [str("lunasq.run_id", "R1"), str("session.id", "s-1")],
      ),
    );
    expect(found[0]).toMatchObject({ runId: "R2", sessionId: "s-1" });
  });

  it("descarta una llamada sin modelo o con tokens inválidos en vez de fallar el lote", () => {
    const ok = request([str("model", "m"), attr("input_tokens", { intValue: 1 })]);
    const noModel = request([attr("input_tokens", { intValue: 1 })]);
    const negative = request([str("model", "m"), attr("input_tokens", { intValue: -4 })]);
    const fractional = request([str("model", "m"), attr("output_tokens", { doubleValue: 1.5 })]);
    expect(apiRequests(batch([noModel, ok, negative, fractional]))).toHaveLength(1);
  });
});
