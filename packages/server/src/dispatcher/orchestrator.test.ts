import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr, FakeProcessRunner } from "@lunasq/adapters";
import { claimRun, closeRun, ProjectRepository, RunRepository, transitionTask } from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { type Notification, SchedulerConfig, type SchedulerConfigInput } from "@lunasq/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Escalator } from "../notifications/escalator.ts";
import { OutboxPublisher } from "../outbox/publisher.ts";
import { Orchestrator } from "./orchestrator.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function setup(
  opts: {
    config?: SchedulerConfigInput;
    db?: ReturnType<typeof migratedDatabase>;
    herdr?: FakeHerdr;
  } = {},
) {
  const db = opts.db ?? migratedDatabase();
  const dir = mkdtempSync(join(tmpdir(), "lunasq-orch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  // Los prompts no terminan solos: sin nudges en medio de los escenarios.
  const herdr = opts.herdr ?? new FakeHerdr({ promptDurationMs: 2 ** 31 - 1 });
  const publisher = new OutboxPublisher({ db, pollIntervalMs: 10 });
  const notifications: Notification[] = [];
  const notify = (n: Notification) => {
    notifications.push(n);
  };
  const escalator = new Escalator({ notify });
  cleanups.push(() => escalator.stop());
  const orchestrator = new Orchestrator({
    db,
    herdr,
    processes: new FakeProcessRunner(),
    mcp: { configPath: join(dir, "mcp.json"), url: "http://127.0.0.1:4518/mcp" },
    hooks: {
      settingsPath: join(dir, "settings.json"),
      url: "http://127.0.0.1:4518/hooks/subagent",
    },
    publisher,
    notifications: { notify, escalator },
    config: { tickIntervalMs: 60_000, ...opts.config },
  });
  cleanups.push(() => orchestrator.stop());
  const project = opts.db
    ? (new ProjectRepository(db).list()[0] ?? insertProject(db))
    : insertProject(db);
  return { db, dir, herdr, publisher, orchestrator, notifications, project };
}

describe("Orchestrator", () => {
  it("al arrancar escribe el archivo MCP y despacha lo que está listo", async () => {
    const { db, dir, herdr, orchestrator, project } = setup();
    const task = insertTask(db, project.id);

    await orchestrator.start();
    await orchestrator.dispatcher.idle();

    expect(readFileSync(join(dir, "mcp.json"), "utf8")).toContain(`\${LUNASQ_RUN_TOKEN}`);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toContain("/hooks/subagent");
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

  it("cuando una tool del MCP cierra el Run y la tarea sale de running, limpia el pane", async () => {
    const { db, herdr, orchestrator, publisher, project } = setup();
    const task = insertTask(db, project.id);
    await orchestrator.start();
    await orchestrator.dispatcher.idle();
    const [run] = new RunRepository(db).forTask(task.id);
    if (!run?.herdrName) throw new Error("sin Run");
    expect(await herdr.getAgent(run.herdrName)).toBeDefined();

    // Como la tool de salida: cierra el Run y transiciona en la misma transacción.
    db.transaction((tx) => {
      closeRun(tx, run.id, { result: "failure", failureReason: "x" });
    });
    transitionTask(db, {
      taskId: task.id,
      actor: "system",
      command: { type: "escalate", reason: "phase_timeout" },
    });
    await publisher.start();
    cleanups.push(() => publisher.stop());

    await vi.waitFor(async () => expect(await herdr.getAgent(run.herdrName ?? "")).toBeUndefined());
  });

  it("un Run abierto no se limpia aunque llegue la transición", async () => {
    const { db, herdr, orchestrator, project } = setup();
    const task = insertTask(db, project.id);
    await orchestrator.start();
    await orchestrator.dispatcher.idle();
    const [run] = new RunRepository(db).forTask(task.id);
    await orchestrator.dispatcher.releaseRun(run?.id ?? "");
    expect(await herdr.getAgent(run?.herdrName ?? "")).toBeDefined();
  });
});

describe("Orchestrator: escenarios de fallo", () => {
  const taskState = (db: ReturnType<typeof migratedDatabase>, id: string) =>
    db.$client.prepare("select state, sub_state as subState from tasks where id = ?").get(id) as {
      state: string;
      subState: string | null;
    };

  async function startAll(ctx: ReturnType<typeof setup>) {
    await ctx.orchestrator.start();
    await ctx.publisher.start();
    cleanups.push(() => ctx.publisher.stop());
  }

  it("cada crash reintenta tras el backoff y, agotados los 3 reintentos, needs_human con aviso", async () => {
    const ctx = setup({ config: { retryBackoffMs: 0 } });
    const { db, herdr, orchestrator, project, notifications } = ctx;
    const task = insertTask(db, project.id);
    const runs = new RunRepository(db);
    await startAll(ctx);

    for (let attempt = 1; attempt <= 4; attempt++) {
      await vi.waitFor(
        async () => {
          await orchestrator.scheduler.run();
          await orchestrator.dispatcher.idle();
          expect(runs.forTask(task.id)).toHaveLength(attempt);
          expect(runs.latestForTask(task.id)?.launchedAt).toBeInstanceOf(Date);
        },
        { timeout: 2000 },
      );
      const crashed = runs.latestForTask(task.id);
      herdr.exitAgent(crashed?.herdrName ?? "");
      // Con backoff 0 el reintento se despacha enseguida: se mira el Run que cayó.
      await vi.waitFor(() => expect(runs.get(crashed?.id ?? "")?.result).toBe("failure"));
    }

    await vi.waitFor(() => expect(taskState(db, task.id).state).toBe("needs_human"));
    await vi.waitFor(() =>
      expect(notifications).toEqual([
        expect.objectContaining({ kind: "retries_exhausted", taskId: task.id }),
      ]),
    );
    expect(runs.forTask(task.id).map((r) => r.failureReason?.split(":")[0])).toEqual([
      "agent_exited",
      "agent_exited",
      "agent_exited",
      "agent_exited",
    ]);
  });

  it("durante el backoff la tarea no se vuelve a despachar", async () => {
    const ctx = setup({ config: { retryBackoffMs: 60 * 60_000 } });
    const { db, herdr, orchestrator, project } = ctx;
    const task = insertTask(db, project.id);
    const runs = new RunRepository(db);
    await startAll(ctx);
    await orchestrator.dispatcher.idle();
    herdr.exitAgent(runs.latestForTask(task.id)?.herdrName ?? "");
    await vi.waitFor(() => expect(taskState(db, task.id).subState).toBe("queued"));

    expect((await orchestrator.scheduler.run()).dispatched).toEqual([]);
    expect(runs.forTask(task.id)).toHaveLength(1);
  });

  it("vencido el backoff, la tarea se vuelve a despachar", async () => {
    const ctx = setup({ config: { retryBackoffMs: 300 } });
    const { db, herdr, orchestrator, project } = ctx;
    const task = insertTask(db, project.id);
    const runs = new RunRepository(db);
    await startAll(ctx);
    await orchestrator.dispatcher.idle();
    herdr.exitAgent(runs.latestForTask(task.id)?.herdrName ?? "");
    await vi.waitFor(() => expect(taskState(db, task.id).subState).toBe("queued"));
    expect((await orchestrator.scheduler.run()).dispatched).toEqual([]);

    await vi.waitFor(async () => {
      await orchestrator.scheduler.run();
      expect(runs.forTask(task.id)).toHaveLength(2);
    });
    expect(taskState(db, task.id).subState).toBe("running");
  });

  it("al reanudar tras un timeout, el Run viejo se cierra y la fase se redespacha sola", async () => {
    const ctx = setup();
    const { db, orchestrator, project } = ctx;
    const task = insertTask(db, project.id);
    const runs = new RunRepository(db);
    await startAll(ctx);
    await orchestrator.dispatcher.idle();
    const first = runs.latestForTask(task.id);
    transitionTask(db, {
      taskId: task.id,
      actor: "system",
      command: { type: "escalate", reason: "phase_timeout" },
    });
    transitionTask(db, { taskId: task.id, actor: "human", command: { type: "resume" } });

    // Sin llamar al scheduler: el tick es de 60 s, así que lo despierta la reconciliación.
    await vi.waitFor(() => {
      expect(runs.get(first?.id ?? "")?.result).toBe("cancelled");
      expect(runs.forTask(task.id)).toHaveLength(2);
    });
  });

  it("si se pierden eventos de herdr, la reconciliación detecta el agente caído", async () => {
    const ctx = setup({ config: { retryBackoffMs: 60 * 60_000 } });
    const { db, herdr, orchestrator, project } = ctx;
    const task = insertTask(db, project.id);
    await startAll(ctx);
    await orchestrator.dispatcher.idle();
    const run = new RunRepository(db).latestForTask(task.id);
    // El evento del crash se perdió: nadie observaba cuando el agente salió.
    orchestrator.watcher.unwatch(run?.id ?? "");
    herdr.exitAgent(run?.herdrName ?? "");
    // El stream de ciclo de vida se corta: herdr no dice qué se perdió.
    herdr.dropStreams();

    await vi.waitFor(() =>
      expect(new RunRepository(db).get(run?.id ?? "")?.failureReason).toMatch(/^agent_lost:/),
    );
    expect(taskState(db, task.id)).toEqual({ state: "draft", subState: "queued" });
  });

  it("al reiniciar el proceso vuelve a observar los Runs vivos", async () => {
    const first = setup();
    const task = insertTask(first.db, first.project.id);
    await first.orchestrator.start();
    await first.orchestrator.dispatcher.idle();
    await first.orchestrator.stop();
    const run = new RunRepository(first.db).latestForTask(task.id);

    const second = setup({ db: first.db, herdr: first.herdr });
    await second.orchestrator.start();
    expect(second.orchestrator.watcher.watching()).toEqual([run?.id]);
  });

  it("una tarea cancelada detiene su agente y remueve su worktree", async () => {
    const ctx = setup();
    const { db, herdr, orchestrator, project } = ctx;
    const task = insertTask(db, project.id);
    await startAll(ctx);
    await orchestrator.dispatcher.idle();
    const run = new RunRepository(db).latestForTask(task.id);

    transitionTask(db, { taskId: task.id, actor: "human", command: { type: "cancel" } });

    await vi.waitFor(async () => {
      expect(await herdr.getAgent(run?.herdrName ?? "")).toBeUndefined();
      const row = db.$client
        .prepare("select worktree_path as p from tasks where id = ?")
        .get(task.id) as { p: string | null };
      expect(row.p).toBeNull();
    });
    expect(new RunRepository(db).get(run?.id ?? "")?.result).toBe("cancelled");
  });
});
