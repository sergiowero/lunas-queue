import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr, FakeProcessRunner } from "@lunasq/adapters";
import { claimRun, ProjectRepository, RunRepository } from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { SchedulerConfig } from "@lunasq/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { OutboxPublisher } from "../outbox/publisher.ts";
import { Orchestrator } from "./orchestrator.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function setup() {
  const db = migratedDatabase();
  const dir = mkdtempSync(join(tmpdir(), "lunasq-orch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const herdr = new FakeHerdr();
  const publisher = new OutboxPublisher({ db });
  const orchestrator = new Orchestrator({
    db,
    herdr,
    processes: new FakeProcessRunner(),
    mcp: { configPath: join(dir, "mcp.json"), url: "http://127.0.0.1:4518/mcp" },
    publisher,
    config: { tickIntervalMs: 60_000 },
  });
  cleanups.push(() => orchestrator.stop());
  return { db, dir, herdr, publisher, orchestrator, project: insertProject(db) };
}

describe("Orchestrator", () => {
  it("al arrancar escribe el archivo MCP y despacha lo que está listo", async () => {
    const { db, dir, herdr, orchestrator, project } = setup();
    const task = insertTask(db, project.id);

    await orchestrator.start();
    await orchestrator.dispatcher.idle();

    expect(readFileSync(join(dir, "mcp.json"), "utf8")).toContain(`\${LUNASQ_RUN_TOKEN}`);
    const [run] = new RunRepository(db).forTask(task.id);
    expect(run?.launchedAt).toBeInstanceOf(Date);
    expect((await herdr.snapshot()).agents.map((a) => a.name)).toEqual([run?.herdrName]);
  });

  it("al arrancar retoma un Run reclamado antes de la caída", async () => {
    const { db, herdr, orchestrator, project } = setup();
    const task = insertTask(db, project.id);
    const claim = claimRun(db, {
      decision: {
        taskId: task.id,
        projectId: project.id,
        phase: "refine",
        expected: { state: "draft", subState: "queued" },
      },
      config: SchedulerConfig.parse({}),
      projects: new ProjectRepository(db),
      sessionId: "s-1",
    });
    if (!claim.ok) throw new Error(claim.error.message);

    await orchestrator.start();
    await orchestrator.dispatcher.idle();

    expect((await herdr.snapshot()).agents.map((a) => a.name)).toEqual([claim.run.herdrName]);
  });

  it("una tarea nueva que entra por el outbox se despacha", async () => {
    const { db, herdr, orchestrator, publisher, project } = setup();
    await orchestrator.start();
    await publisher.start();
    cleanups.push(() => publisher.stop());

    const task = insertTask(db, project.id);
    // Cualquier transición escribe outbox; aquí basta con despertar al scheduler por el tick.
    await orchestrator.scheduler.run();
    await orchestrator.dispatcher.idle();

    const [run] = new RunRepository(db).forTask(task.id);
    expect((await herdr.snapshot()).agents.map((a) => a.name)).toEqual([run?.herdrName]);
  });
});
