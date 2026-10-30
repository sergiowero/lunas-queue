import { describe, expect, it } from "vitest";
import { usageRecords } from "./schema.ts";
import { insertProject, insertRun, insertTask, migratedDatabase } from "./test-helpers.ts";
import { type UsageInput, UsageRepository } from "./usage.ts";

function setup() {
  const db = migratedDatabase();
  const run = insertRun(db, insertTask(db, insertProject(db).id).id);
  return { db, run, repo: new UsageRepository(db) };
}

const request = (sourceRef: string | null, overrides: Partial<UsageInput> = {}): UsageInput => ({
  model: "claude-haiku-5-5",
  inputTokens: 2,
  outputTokens: 289,
  cacheReadTokens: 0,
  cacheWriteTokens: 28702,
  costUsd: 0.0058851,
  source: "otel",
  sourceRef,
  agentId: null,
  ...overrides,
});

describe("UsageRepository.record", () => {
  it("guarda un registro por request con el agente que lo hizo", () => {
    const { db, run, repo } = setup();
    expect(repo.record(run.id, [request("req_1"), request("req_2", { agentId: "a1" })])).toBe(2);
    const rows = db.select().from(usageRecords).all();
    expect(rows.map((r) => [r.runId, r.sourceRef, r.agentId, r.source])).toEqual([
      [run.id, "req_1", null, "otel"],
      [run.id, "req_2", "a1", "otel"],
    ]);
  });

  it("reenviar el mismo lote no duplica tokens", () => {
    const { db, run, repo } = setup();
    repo.record(run.id, [request("req_1")]);
    expect(repo.record(run.id, [request("req_1"), request("req_2")])).toBe(1);
    expect(db.select().from(usageRecords).all()).toHaveLength(2);
  });

  it("sin source_ref no deduplica y un lote vacío no hace nada", () => {
    const { db, run, repo } = setup();
    expect(repo.record(run.id, [])).toBe(0);
    repo.record(run.id, [request(null), request(null)]);
    expect(db.select().from(usageRecords).all()).toHaveLength(2);
  });

  it("acepta costo desconocido", () => {
    const { db, run, repo } = setup();
    repo.record(run.id, [request("req_1", { costUsd: null })]);
    expect(db.select().from(usageRecords).get()?.costUsd).toBeNull();
  });
});
