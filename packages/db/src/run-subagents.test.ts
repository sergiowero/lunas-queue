import { describe, expect, it } from "vitest";
import { RunSubagentRepository } from "./run-subagents.ts";
import { runSubagents } from "./schema.ts";
import { insertProject, insertRun, insertTask, migratedDatabase } from "./test-helpers.ts";

function setup() {
  const db = migratedDatabase();
  const task = insertTask(db, insertProject(db).id);
  const run = insertRun(db, task.id, { phase: "verify" });
  return { db, task, run, repo: new RunSubagentRepository(db) };
}

const code = { agentId: "a1", agentType: "lunasq-code-reviewer" };

describe("RunSubagentRepository", () => {
  it("registra inicio y fin de un subagente del Run", () => {
    const { run, repo } = setup();
    repo.recordStart(run.id, code);
    expect(repo.forRun(run.id)).toEqual([
      expect.objectContaining({
        ...code,
        runId: run.id,
        startedAt: expect.any(Date),
        stoppedAt: null,
      }),
    ]);
    repo.recordStop(run.id, { ...code, transcriptPath: "/tmp/agent-a1.jsonl" });
    const [row] = repo.forRun(run.id);
    expect(row?.stoppedAt).toBeInstanceOf(Date);
    expect(row?.transcriptPath).toBe("/tmp/agent-a1.jsonl");
  });

  it("repetir un hook no duplica la ejecución ni mueve sus tiempos", () => {
    const { run, repo } = setup();
    repo.recordStart(run.id, code);
    repo.recordStop(run.id, code);
    const [first] = repo.forRun(run.id);
    repo.recordStart(run.id, code);
    repo.recordStop(run.id, { ...code, transcriptPath: "/tmp/otro.jsonl" });
    expect(repo.forRun(run.id)).toEqual([first]);
  });

  it("un fin sin inicio (hook perdido) también deja la ejecución registrada", () => {
    const { run, repo } = setup();
    repo.recordStop(run.id, code);
    expect(repo.forRun(run.id)).toEqual([
      expect.objectContaining({ ...code, startedAt: null, stoppedAt: expect.any(Date) }),
    ]);
    repo.recordStart(run.id, code);
    expect(repo.forRun(run.id)[0]?.startedAt).toBeInstanceOf(Date);
  });

  it("separa por Run y ordena por llegada; el mismo agent_id en otro Run es otra ejecución", () => {
    const { db, task, run, repo } = setup();
    const other = insertRun(db, task.id, { phase: "verify", endedAt: new Date() });
    const ux = { agentId: "a2", agentType: "lunasq-ux-reviewer" };
    repo.recordStart(run.id, code);
    repo.recordStart(run.id, ux);
    repo.recordStart(other.id, code);
    expect(repo.forRun(run.id).map((r) => r.agentType)).toEqual([
      "lunasq-code-reviewer",
      "lunasq-ux-reviewer",
    ]);
    expect(repo.forRun(other.id)).toHaveLength(1);
  });

  it("la ejecución se borra con su Run y exige un Run existente", () => {
    const { db, run, repo } = setup();
    expect(() => repo.recordStart("no-existe", code)).toThrow();
    repo.recordStart(run.id, code);
    db.$client.prepare("delete from runs where id = ?").run(run.id);
    expect(db.select().from(runSubagents).all()).toEqual([]);
  });
});
