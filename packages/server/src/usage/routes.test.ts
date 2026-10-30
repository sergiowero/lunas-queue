import { gzipSync } from "node:zlib";
import { RunRepository, RunSubagentRepository } from "@lunasq/db";
import { insertProject, insertRun, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { RUN_TOKEN_HEADER, TaskUsage } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { OTLP_LOGS_PATH, OTLP_METRICS_PATH } from "./routes.ts";

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const int = (key: string, value: number) => ({ key, value: { intValue: value } });

function apiRequest(ref: string, extra: object[] = [], tokens = 10) {
  return {
    body: { stringValue: "claude_code.api_request" },
    attributes: [
      str("event.name", "api_request"),
      str("model", "claude-opus-5-5"),
      str("request_id", ref),
      int("input_tokens", tokens),
      { key: "cost_usd", value: { doubleValue: tokens / 100 } },
      ...extra,
    ],
  };
}

const logs = (runId: string, records: object[], resource: object[] = []) => ({
  resourceLogs: [
    {
      resource: { attributes: [str("lunasq.run_id", runId), ...resource] },
      scopeLogs: [{ logRecords: records }],
    },
  ],
});

function setup(runOverrides: Parameters<typeof insertRun>[2] = {}) {
  const db = migratedDatabase();
  const task = insertTask(db, insertProject(db).id);
  const run = insertRun(db, task.id, { phase: "verify", ...runOverrides });
  const app = createApp({ db });
  const post = (
    body: unknown,
    { token = run.runToken, path = OTLP_LOGS_PATH, headers = {} } = {} as {
      token?: string | null;
      path?: string;
      headers?: Record<string, string>;
    },
  ) =>
    app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { [RUN_TOKEN_HEADER]: token }),
        ...headers,
      },
      body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
    });
  const usage = async (taskId = task.id) =>
    TaskUsage.parse(await (await app.request(`/api/tasks/${taskId}/usage`)).json());
  return { db, task, run, post, usage };
}

describe("POST /v1/logs", () => {
  it("guarda cada api_request en el Run del token y lo suma al usage de la tarea", async () => {
    const { run, post, usage } = setup();
    const res = await post(
      logs(run.id, [apiRequest("req_1", [], 10), apiRequest("req_2", [], 30)]),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const body = await usage();
    expect(body.total).toEqual({
      inputTokens: 40,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.4,
    });
    expect(body.byRun).toEqual([expect.objectContaining({ runId: run.id, phase: "verify" })]);
    expect(body.byModel).toEqual([expect.objectContaining({ model: "claude-opus-5-5" })]);
  });

  it("reenviar el lote no duplica el consumo", async () => {
    const { run, post, usage } = setup();
    const batch = logs(run.id, [apiRequest("req_1")]);
    await post(batch);
    await post(batch);
    expect((await usage()).total.inputTokens).toBe(10);
  });

  it("acepta el último lote de un Run ya cerrado", async () => {
    const { db, run, post, usage } = setup();
    new RunRepository(db).close(run.id, { result: "success" });
    await post(logs(run.id, [apiRequest("req_1")]));
    expect((await usage()).total.inputTokens).toBe(10);
  });

  it("acepta el cuerpo comprimido con gzip", async () => {
    const { run, post, usage } = setup();
    const res = await post(gzipSync(JSON.stringify(logs(run.id, [apiRequest("req_1")]))), {
      headers: { "content-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect((await usage()).total.inputTokens).toBe(10);
  });

  it("con token ausente o desconocido responde {} sin guardar nada", async () => {
    const { run, post, usage } = setup();
    for (const token of [null, "desconocido"]) {
      const res = await post(logs(run.id, [apiRequest("req_1")]), { token });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
    }
    expect((await usage()).byRun).toEqual([]);
  });

  it("descarta lo que declara otro Run: un proceso que hereda el token no suma al Run ajeno", async () => {
    const { db, run, post, usage } = setup();
    const other = insertRun(db, insertTask(db, insertProject(db).id).id, { phase: "verify" });
    await post(logs(other.id, [apiRequest("req_1")]));
    await post({
      resourceLogs: [{ scopeLogs: [{ logRecords: [apiRequest("req_2")] }] }],
    });
    expect((await usage()).total.inputTokens).toBe(0);
    expect((await usage(other.taskId)).total.inputTokens).toBe(0);
    expect(run.id).not.toBe(other.id);
  });

  it("con session id nativo solo cuenta la sesión del Run", async () => {
    const { run, post, usage } = setup({ agentSession: "s-1", agentSessionSource: "native" });
    await post(logs(run.id, [apiRequest("req_1")], [str("session.id", "s-otra")]));
    expect((await usage()).total.inputTokens).toBe(0);
    await post(logs(run.id, [apiRequest("req_2")], [str("session.id", "s-1")]));
    expect((await usage()).total.inputTokens).toBe(10);
  });

  it("atribuye al revisor lo que llega con el agent_id que registraron los hooks de subagentes", async () => {
    const { db, run, post, usage } = setup();
    new RunSubagentRepository(db).recordStart(run.id, {
      agentId: "a1",
      agentType: "lunasq-code-reviewer",
    });
    await post(
      logs(run.id, [
        apiRequest("req_main", [], 5),
        apiRequest("req_rev", [str("agent_id", "a1")], 20),
      ]),
    );
    const body = await usage();
    expect(body.total.inputTokens).toBe(25);
    expect(body.byReviewer).toEqual([
      expect.objectContaining({ reviewer: "lunasq-code-reviewer" }),
    ]);
    expect(body.byReviewer[0]?.usage.inputTokens).toBe(20);
  });

  it("un valor de atributo con tipo inesperado no tumba el lote", async () => {
    const { run, post, usage } = setup();
    const odd = { key: "otro", value: { doubleValue: "NaN", intValue: { x: 1 } } };
    await post(logs(run.id, [apiRequest("req_1", [odd])]));
    expect((await usage()).total.inputTokens).toBe(10);
  });

  it("valida el token antes de leer el cuerpo: sin token no se descomprime nada", async () => {
    const { post } = setup();
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024));
    const res = await post(bomb, { token: null, headers: { "content-encoding": "gzip" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("rechaza con 413 un cuerpo demasiado grande y un gzip que expande más del tope", async () => {
    const { post, usage } = setup();
    const big = await post(Buffer.alloc(9 * 1024 * 1024, 32), {
      headers: { "content-length": String(9 * 1024 * 1024) },
    });
    expect(big.status).toBe(413);
    const bomb = await post(gzipSync(Buffer.alloc(40 * 1024 * 1024)), {
      headers: { "content-encoding": "gzip" },
    });
    expect(bomb.status).toBe(400);
    expect((await usage()).byRun).toEqual([]);
  });

  it("responde 400 si el cuerpo no es JSON ni OTLP", async () => {
    const { post } = setup();
    expect((await post("no es json")).status).toBe(400);
    expect((await post({ resourceLogs: "x" })).status).toBe(400);
  });
});

describe("POST /v1/metrics", () => {
  it("lo acepta y no guarda nada: las métricas son delta y no traen request id", async () => {
    const { post, usage } = setup();
    const res = await post(
      { resourceMetrics: [{ scopeMetrics: [] }] },
      { path: OTLP_METRICS_PATH },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect((await usage()).byRun).toEqual([]);
  });
});

describe("feature flag telemetry", () => {
  it("con telemetry: false no monta los endpoints OTLP", async () => {
    const db = migratedDatabase();
    const app = createApp({ db, telemetry: false });
    for (const path of [OTLP_LOGS_PATH, OTLP_METRICS_PATH]) {
      expect((await app.request(path, { method: "POST", body: "{}" })).status).toBe(404);
    }
  });
});
