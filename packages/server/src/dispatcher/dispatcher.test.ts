import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr, FakeProcessRunner, TRUST_ACCEPT_KEYS } from "@lunasq/adapters";
import {
  claimRun,
  closeRun,
  ProjectRepository,
  ProjectWorkspaceRepository,
  RunRepository,
  TaskWorktreeRepository,
} from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { agentName, type DispatchDecision, phasePrompt } from "@lunasq/domain";
import { type Project, SchedulerConfig, type SchedulerConfigInput } from "@lunasq/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../scheduler/scheduler.ts";
import { WorktreeService } from "../worktrees/service.ts";
import {
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  isDispatchError,
  PhaseDispatcher,
  type PhaseDispatcherOptions,
} from "./dispatcher.ts";

const MCP_CONFIG = "/cfg/lunasq-mcp.json";
const HOOK_SETTINGS = "/cfg/lunasq-settings.json";

const stoppables: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((s) => s.stop()));
});

function setup(
  opts: {
    herdr?: FakeHerdr;
    config?: SchedulerConfigInput;
    concurrency?: number;
    agentProfiles?: Partial<Project["agentProfiles"]>;
    dispatcher?: Partial<PhaseDispatcherOptions>;
  } = {},
) {
  const db = migratedDatabase();
  const project = insertProject(db, {
    bootstrap: "pnpm install",
    limits: opts.concurrency === undefined ? {} : { concurrency: opts.concurrency },
    agentProfiles: {
      refine: { kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] },
      ...opts.agentProfiles,
    },
  });
  const herdr = opts.herdr ?? new FakeHerdr();
  const processes = new FakeProcessRunner();
  const projects = new ProjectRepository(db);
  const workspaces = new ProjectWorkspaceRepository(db);
  const worktrees = new WorktreeService({
    herdr,
    processes,
    projects,
    tasks: new TaskWorktreeRepository(db),
    workspaces,
  });
  const errors: { error: Error; runId: string | null }[] = [];
  let sessions = 0;
  const make = (extra: Partial<PhaseDispatcherOptions> = {}) =>
    new PhaseDispatcher({
      db,
      herdr,
      worktrees,
      projects,
      ...(opts.config && { config: opts.config }),
      mcpConfigPath: MCP_CONFIG,
      mcpUrl: "http://127.0.0.1:8123/mcp",
      hookSettingsPath: HOOK_SETTINGS,
      paneEnv: { EXTRA: "1" },
      newSessionId: () => `sess-${++sessions}`,
      onError: (error, runId) => errors.push({ error, runId }),
      ...opts.dispatcher,
      ...extra,
    });
  const dispatcher = make();
  const runs = new RunRepository(db);
  const taskRow = (id: string) =>
    db.$client
      .prepare(
        "select state, sub_state as subState, worktree_path as worktreePath from tasks where id = ?",
      )
      .get(id) as { state: string; subState: string | null; worktreePath: string | null };
  return {
    db,
    project,
    herdr,
    processes,
    worktrees,
    workspaces,
    dispatcher,
    make,
    runs,
    errors,
    taskRow,
  };
}

const refine = (task: { id: string; projectId: string }): DispatchDecision => ({
  taskId: task.id,
  projectId: task.projectId,
  phase: "refine",
  agentKind: "claude",
  score: 0,
  expected: { state: "draft", subState: "queued" },
});

async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("no lanzó");
    },
    (err: unknown) => err,
  );
}

describe("PhaseDispatcher: despacho de punta a punta", () => {
  it("lanza Copilot con MCP tokenizado por Run y sin entorno de telemetría de Claude", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lunasq-copilot-mcp-"));
    stoppables.push({ stop: async () => rmSync(configDir, { recursive: true, force: true }) });
    const { db, project, herdr, runs, make } = setup({
      agentProfiles: {
        refine: { kind: "copilot", model: "gpt-5", effort: "medium", args: [] },
      },
      dispatcher: {
        mcpConfigPath: join(configDir, "stable-mcp.json"),
        paneEnv: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "otlp" },
      },
    });
    const dispatcher = make({ mcpUrl: "http://127.0.0.1:8123/mcp" });
    const task = insertTask(db, project.id);
    let mcpDuringStart: unknown;
    const start = herdr.startAgent.bind(herdr);
    vi.spyOn(herdr, "startAgent").mockImplementationOnce(async (input) => {
      const args = input.args ?? [];
      const mcpFlag = args.indexOf("--additional-mcp-config");
      const configArg = args[mcpFlag + 1];
      if (configArg?.startsWith("@")) {
        mcpDuringStart = JSON.parse(readFileSync(configArg.slice(1), "utf8"));
      }
      return start(input);
    });

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    const [run] = runs.forTask(task.id);
    const name = run?.herdrName ?? "";
    expect(run?.agentKind).toBe("copilot");
    expect(herdr.agentArgs(name)).toEqual([
      "--model",
      "gpt-5",
      "--reasoning-effort",
      "medium",
      "--allow-all-tools",
      "--trust-folder",
      "--session-id",
      run?.agentSession,
      "--additional-mcp-config",
      expect.stringMatching(/^@/),
    ]);
    expect(mcpDuringStart).toEqual({
      mcpServers: {
        lunasq: {
          type: "http",
          url: "http://127.0.0.1:8123/mcp",
          headers: { "X-LunasQ-Run-Token": run?.runToken },
        },
      },
    });
    expect(herdr.paneEnv(run?.herdrPane ?? "")).not.toHaveProperty("CLAUDE_CODE_ENABLE_TELEMETRY");
    expect(herdr.paneEnv(run?.herdrPane ?? "")).not.toHaveProperty("OTEL_METRICS_EXPORTER");
    expect(herdr.paneEnv(run?.herdrPane ?? "")).not.toHaveProperty("MCP_TOOL_TIMEOUT");
    expect(herdr.paneEnv(run?.herdrPane ?? "")).toMatchObject({ LUNASQ_RUN_TOKEN: run?.runToken });
  });

  it("reclama, prepara el worktree, levanta el agente con su entorno y le manda la fase", async () => {
    const { db, project, herdr, dispatcher, runs, taskRow, errors, workspaces } = setup();
    const task = insertTask(db, project.id);

    await dispatcher.dispatch(refine(task));
    // Al resolver, el claim ya está confirmado: la tarea ocupa su slot.
    expect(taskRow(task.id)).toMatchObject({ state: "draft", subState: "running" });
    await dispatcher.idle();

    expect(errors).toEqual([]);
    const [run] = runs.forTask(task.id);
    if (!run) throw new Error("sin Run");
    const name = agentName(task.id, "refine", 1);
    expect(run).toMatchObject({
      herdrName: name,
      agentSession: "sess-1",
      agentSessionSource: "native",
      endedAt: null,
    });
    expect(run.launchedAt).toBeInstanceOf(Date);

    const agent = await herdr.getAgent(name);
    expect(agent).toMatchObject({
      kind: "claude",
      paneId: run.herdrPane,
      workspaceId: run.herdrWorkspace,
    });
    // El título del pane identifica la tarea por su número; branch y agente siguen con el UUID.
    expect(agent?.title).toBe(`LunasQ refine #${task.number}`);
    expect(agent?.tokens).toEqual({
      task: task.id,
      phase: "refine",
      iter: "0",
      run: run.id,
    });
    expect(herdr.agentArgs(name)).toEqual([
      "--model",
      "sonnet",
      "--permission-mode",
      "auto",
      "--mcp-config",
      MCP_CONFIG,
      "--strict-mcp-config",
      "--settings",
      HOOK_SETTINGS,
      "--session-id",
      "sess-1",
    ]);
    expect(herdr.paneEnv(run.herdrPane ?? "")).toMatchObject({
      EXTRA: "1",
      MCP_TOOL_TIMEOUT: String(DEFAULT_MCP_TOOL_TIMEOUT_MS),
      CLAUDE_CODE_FORK_SUBAGENT: "0",
      LUNASQ_RUN_TOKEN: run.runToken,
      LUNASQ_TASK_ID: task.id,
      LUNASQ_RUN_ID: run.id,
      LUNASQ_PHASE: "refine",
    });
    expect(await herdr.readAgent({ name })).toBe(phasePrompt("refine", task.id));

    // El pane abre en el worktree de la tarea, dentro del workspace del worktree.
    const row = taskRow(task.id);
    const snap = await herdr.snapshot();
    expect(snap.panes.find((p) => p.paneId === run.herdrPane)?.cwd).toBe(row?.worktreePath);
    expect(workspaces.get(project.id)).not.toBeNull();
  });

  it("paneEnv sobrescribe los defaults del pane, como CLAUDE_CODE_FORK_SUBAGENT", async () => {
    const { db, project, herdr, dispatcher, runs } = setup({
      dispatcher: { paneEnv: { CLAUDE_CODE_FORK_SUBAGENT: "1" } },
    });
    const task = insertTask(db, project.id);
    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();
    const [run] = runs.forTask(task.id);
    expect(herdr.paneEnv(run?.herdrPane ?? "")).toMatchObject({ CLAUDE_CODE_FORK_SUBAGENT: "1" });
  });

  it("con telemetría activa, el pane lleva los atributos del Run y el run token como header OTLP", async () => {
    const { db, project, herdr, dispatcher, runs } = setup({
      dispatcher: { paneEnv: { CLAUDE_CODE_ENABLE_TELEMETRY: "1" } },
    });
    const task = insertTask(db, project.id);
    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();
    const [run] = runs.forTask(task.id);
    expect(herdr.paneEnv(run?.herdrPane ?? "")).toMatchObject({
      OTEL_RESOURCE_ATTRIBUTES: `lunasq.task_id=${task.id},lunasq.run_id=${run?.id},lunasq.phase=refine`,
      OTEL_EXPORTER_OTLP_HEADERS: `X-LunasQ-Run-Token=${run?.runToken}`,
    });
  });

  it("con telemetría apagada, el pane no lleva variables OTEL", async () => {
    const { db, project, herdr, dispatcher, runs } = setup();
    const task = insertTask(db, project.id);
    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();
    const [run] = runs.forTask(task.id);
    const env = herdr.paneEnv(run?.herdrPane ?? "");
    expect(Object.keys(env).filter((k) => k.startsWith("OTEL_"))).toEqual([]);
  });

  it("repetir el despacho no duplica agentes ni panes", async () => {
    const { db, project, herdr, dispatcher, runs } = setup();
    const task = insertTask(db, project.id);
    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();
    const panesBefore = (await herdr.snapshot()).panes.length;

    const err = await rejection(dispatcher.dispatch(refine(task)));
    await dispatcher.idle();

    expect(isDispatchError(err, "stale_state")).toBe(true);
    const snap = await herdr.snapshot();
    expect(snap.agents).toHaveLength(1);
    expect(snap.panes).toHaveLength(panesBefore);
    expect(runs.forTask(task.id)).toHaveLength(1);
  });

  it("rechaza sin tocar herdr si no hay slot", async () => {
    const { db, project, herdr, dispatcher } = setup({ concurrency: 1 });
    await dispatcher.dispatch(refine(insertTask(db, project.id)));
    const spy = vi.spyOn(herdr, "splitPane");

    const err = await rejection(dispatcher.dispatch(refine(insertTask(db, project.id))));

    expect(isDispatchError(err, "no_slot")).toBe(true);
    await dispatcher.idle();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("PhaseDispatcher: retomar un despacho a medias", () => {
  function claimOnly(ctx: ReturnType<typeof setup>, task: { id: string; projectId: string }) {
    const res = claimRun(ctx.db, {
      decision: refine(task),
      config: SchedulerConfig.parse({}),
      projects: new ProjectRepository(ctx.db),
      sessionId: "sess-crash",
    });
    if (!res.ok) throw new Error(res.error.message);
    return res.run;
  }

  it("recover lanza los Runs reclamados que no llegaron a lanzar, una sola vez", async () => {
    const ctx = setup();
    const task = insertTask(ctx.db, ctx.project.id);
    const run = claimOnly(ctx, task);

    await ctx.dispatcher.recover();
    await ctx.dispatcher.recover();
    await ctx.dispatcher.idle();

    const snap = await ctx.herdr.snapshot();
    expect(snap.agents.map((a) => a.name)).toEqual([run.herdrName]);
    expect(await ctx.herdr.readAgent({ name: run.herdrName ?? "" })).toBe(
      phasePrompt("refine", task.id),
    );
    expect(ctx.herdr.agentArgs(run.herdrName ?? "")).toContain("sess-crash");
    expect(ctx.runs.get(run.id)?.launchedAt).toBeInstanceOf(Date);
  });

  it("si el proceso cayó con el agente ya arrancado, lo reutiliza en vez de abrir otro", async () => {
    const ctx = setup();
    const task = insertTask(ctx.db, ctx.project.id);
    // Primer proceso: se cuelga justo después de arrancar el agente.
    vi.spyOn(ctx.herdr, "reportMetadata").mockImplementationOnce(() => new Promise(() => {}));
    await ctx.dispatcher.dispatch(refine(task));
    await vi.waitFor(async () => expect((await ctx.herdr.snapshot()).agents).toHaveLength(1));
    const panes = (await ctx.herdr.snapshot()).panes.length;

    // Segundo proceso (reinicio): retoma el mismo Run.
    const restarted = ctx.make();
    await restarted.recover();
    await restarted.idle();

    const snap = await ctx.herdr.snapshot();
    expect(snap.agents).toHaveLength(1);
    expect(snap.panes).toHaveLength(panes);
    const [run] = ctx.runs.forTask(task.id);
    expect(run?.launchedAt).toBeInstanceOf(Date);
    expect(await ctx.herdr.readAgent({ name: run?.herdrName ?? "" })).toBe(
      phasePrompt("refine", task.id),
    );
  });

  it("si la inicialización de un proveedor quedó interrumpida, continúa con el siguiente", async () => {
    const ctx = setup();
    const task = insertTask(ctx.db, ctx.project.id);
    vi.spyOn(ctx.herdr, "startAgent").mockImplementationOnce(() => new Promise(() => {}));
    await ctx.dispatcher.dispatch(refine(task));
    await vi.waitFor(() => expect(ctx.runs.forTask(task.id)[0]?.herdrPane).not.toBeNull());
    const pane = ctx.runs.forTask(task.id)[0]?.herdrPane;
    const panes = (await ctx.herdr.snapshot()).panes.length;

    const restarted = ctx.make();
    await restarted.recover();
    await restarted.idle();

    const snap = await ctx.herdr.snapshot();
    expect(snap.panes).toHaveLength(panes);
    expect(snap.agents).toHaveLength(1);
    expect(snap.agents[0]?.kind).toBe("copilot");
    expect(snap.agents[0]?.paneId).not.toBe(pane);
    expect(ctx.runs.forTask(task.id)[0]?.agentKind).toBe("copilot");
  });

  it("si cayó después del prompt, no lo repite: el agente ya no está idle", async () => {
    const herdr = new FakeHerdr({ promptDurationMs: 60_000 });
    const ctx = setup({ herdr });
    const task = insertTask(ctx.db, ctx.project.id);
    const original = herdr.promptAgent.bind(herdr);
    // Primer proceso: el prompt llega al agente y el proceso cae antes de marcar el lanzamiento.
    vi.spyOn(herdr, "promptAgent").mockImplementationOnce(async (input) => {
      await original(input);
      return new Promise(() => {});
    });
    await ctx.dispatcher.dispatch(refine(task));
    await vi.waitFor(async () =>
      expect((await herdr.snapshot()).agents[0]?.status).toBe("working"),
    );

    const restarted = ctx.make();
    await restarted.recover();
    await restarted.idle();

    const [run] = ctx.runs.forTask(task.id);
    expect(run?.launchedAt).toBeInstanceOf(Date);
    expect(await herdr.readAgent({ name: run?.herdrName ?? "" })).toBe(
      phasePrompt("refine", task.id),
    );
  });
});

describe("PhaseDispatcher: confianza de carpeta", () => {
  it("acepta el diálogo con down enter y sigue con el prompt", async () => {
    const herdr = new FakeHerdr({ startStatus: "blocked" });
    const { db, project, dispatcher, runs, errors } = setup({ herdr });
    const task = insertTask(db, project.id);

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    expect(errors).toEqual([]);
    const name = runs.forTask(task.id)[0]?.herdrName ?? "";
    expect(herdr.sentKeys(name)).toEqual([[...TRUST_ACCEPT_KEYS]]);
    expect(await herdr.readAgent({ name })).toBe(phasePrompt("refine", task.id));
  });

  it("un bloqueo que no es el diálogo de confianza falla el Run sin mandar teclas", async () => {
    const herdr = new FakeHerdr({ startStatus: "blocked" });
    const { db, project, dispatcher, runs, errors, taskRow } = setup({ herdr });
    vi.spyOn(herdr, "readAgent").mockResolvedValue("Allow this command? (y/n)");
    const task = insertTask(db, project.id);

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    const [run] = runs.forTask(task.id);
    expect(run).toMatchObject({ result: "failure" });
    expect(run?.failureReason).toMatch(/agent_blocked/);
    expect(errors.map((e) => e.runId)).toEqual([run?.id]);
    expect(taskRow(task.id)).toMatchObject({ state: "draft", subState: "queued" });
    expect((await herdr.snapshot()).panes.some((p) => p.paneId === run?.herdrPane)).toBe(false);
  });
});

describe("PhaseDispatcher: fallos al lanzar", () => {
  it("cambia al siguiente proveedor cuando el CLI primario no inicia", async () => {
    const { db, project, herdr, dispatcher, runs } = setup();
    const task = insertTask(db, project.id);
    const kinds: string[] = [];
    const start = herdr.startAgent.bind(herdr);
    vi.spyOn(herdr, "startAgent").mockImplementation(async (input) => {
      kinds.push(input.kind);
      if (input.kind === "claude") throw new Error("claude executable not found");
      return start(input);
    });

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    const [run] = runs.forTask(task.id);
    expect(kinds).toEqual(["claude", "copilot"]);
    expect(run?.agentKind).toBe("copilot");
    expect(runs.providerAttempts(run?.id ?? "")).toEqual([
      { provider: "claude", status: "started" },
      {
        provider: "claude",
        status: "failed",
        reason: "claude executable not found",
      },
      { provider: "copilot", status: "started" },
    ]);
  });

  it("aplica fallback simétrico cuando Copilot es el proveedor primario", async () => {
    const { db, project, herdr, runs, make } = setup({
      agentProfiles: { refine: { kind: "copilot", args: [] } },
    });
    const dispatcher = make();
    const task = insertTask(db, project.id);
    const kinds: string[] = [];
    const start = herdr.startAgent.bind(herdr);
    vi.spyOn(herdr, "startAgent").mockImplementation(async (input) => {
      kinds.push(input.kind);
      if (input.kind === "copilot") throw new Error("copilot command unavailable");
      return start(input);
    });

    await dispatcher.dispatch({
      ...refine(task),
      agentKind: "copilot",
    });
    await dispatcher.idle();

    const [run] = runs.forTask(task.id);
    expect(kinds).toEqual(["copilot", "claude"]);
    expect(run?.agentKind).toBe("claude");
    expect(run?.launchedAt).toBeInstanceOf(Date);
  });

  it("pasa a needs_human y conserva ambos diagnósticos si ningún CLI responde", async () => {
    const { db, project, herdr, dispatcher, runs, taskRow } = setup();
    const task = insertTask(db, project.id);
    vi.spyOn(herdr, "startAgent").mockImplementation(async (input) => {
      throw new Error(`${input.kind} service unavailable`);
    });

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    const [run] = runs.forTask(task.id);
    expect(run).toMatchObject({
      result: "failure",
      failureReason: expect.stringContaining(
        "ningún proveedor respondió al arrancar: claude: claude service unavailable; copilot: copilot service unavailable",
      ),
    });
    expect(taskRow(task.id)).toMatchObject({ state: "needs_human", subState: null });
    expect(
      runs.providerAttempts(run?.id ?? "").filter((attempt) => attempt.status === "failed"),
    ).toHaveLength(2);
  });

  it("un bootstrap que falla cierra el Run como failure y devuelve la tarea a queued", async () => {
    const { db, project, processes, dispatcher, runs, errors, taskRow, herdr } = setup();
    processes.respond((c) => (c.command === "pnpm install" ? { exitCode: 1, stderr: "boom" } : {}));
    const task = insertTask(db, project.id);

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    const [run] = runs.forTask(task.id);
    expect(run).toMatchObject({ result: "failure" });
    expect(run?.failureReason).toMatch(/bootstrap_failed/);
    expect(errors).toHaveLength(1);
    expect(taskRow(task.id)).toMatchObject({ state: "draft", subState: "queued" });
    expect((await herdr.snapshot()).agents).toEqual([]);
  });

  it("un nombre de agente tomado por otro Run falla en vez de adoptarlo", async () => {
    const { db, project, herdr, dispatcher, runs } = setup();
    const task = insertTask(db, project.id);
    const { rootPaneId } = await herdr.ensureWorkspace({ cwd: "/otro", label: "otro" });
    const intruder = await herdr.splitPane({ paneId: rootPaneId });
    await herdr.startAgent({
      name: agentName(task.id, "refine", 1),
      kind: "claude",
      paneId: intruder.paneId,
    });
    await herdr.reportMetadata({ paneId: intruder.paneId, tokens: { run: "otro-run" } });

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    const [run] = runs.forTask(task.id);
    expect(run?.failureReason).toMatch(/agent_name_taken/);
    expect(await herdr.readAgent({ name: agentName(task.id, "refine", 1) })).toBe("");
  });
});

describe("PhaseDispatcher: cierre de fase", () => {
  async function launched() {
    const ctx = setup();
    const task = insertTask(ctx.db, ctx.project.id);
    await ctx.dispatcher.dispatch(refine(task));
    await ctx.dispatcher.idle();
    const [run] = ctx.runs.forTask(task.id);
    if (!run) throw new Error("sin Run");
    return { ...ctx, task, run };
  }

  it("closeRun guarda resultado, handoff y sesión, y cierra el pane", async () => {
    const { dispatcher, herdr, run, runs } = await launched();

    const res = await dispatcher.closeRun(run.id, { result: "success", handoff: { a: 1 } });

    expect(res.closed).toBe(true);
    expect(runs.get(run.id)).toMatchObject({
      result: "success",
      handoff: { a: 1 },
      agentSession: "sess-1",
      agentSessionSource: "native",
    });
    expect(await herdr.getAgent(run.herdrName ?? "")).toBeUndefined();
    expect((await herdr.snapshot()).panes.some((p) => p.paneId === run.herdrPane)).toBe(false);
  });

  it("closeRun sobre un Run que ya cerró el MCP solo limpia el pane", async () => {
    const { db, dispatcher, herdr, run, runs } = await launched();
    closeRun(db, run.id, { result: "success", handoff: { spec: 1 } });

    const res = await dispatcher.closeRun(run.id, { result: "failure" });

    expect(res.closed).toBe(false);
    expect(runs.get(run.id)).toMatchObject({ result: "success", handoff: { spec: 1 } });
    expect(await herdr.getAgent(run.herdrName ?? "")).toBeUndefined();
  });

  it("closeRun es idempotente", async () => {
    const { dispatcher, run, runs } = await launched();
    await dispatcher.closeRun(run.id, { result: "success" });
    const again = await dispatcher.closeRun(run.id, { result: "failure" });
    expect(again.closed).toBe(false);
    expect(runs.get(run.id)?.result).toBe("success");
  });

  it("closeRun usa la sesión de herdr si el Run no tiene una nativa", async () => {
    const { db, dispatcher, herdr, run, runs } = await launched();
    db.$client
      .prepare("update runs set agent_session = null, agent_session_source = null where id = ?")
      .run(run.id);
    herdr.setAgentSession(run.herdrName ?? "", {
      kind: "id",
      source: "herdr:claude",
      value: "h-9",
    });

    await dispatcher.closeRun(run.id, { result: "success" });

    expect(runs.get(run.id)).toMatchObject({ agentSession: "h-9", agentSessionSource: "herdr" });
  });

  it("failRun cierra el pane y devuelve la tarea a queued", async () => {
    const { dispatcher, herdr, run, task, taskRow } = await launched();
    const res = await dispatcher.failRun(run.id, "el agente salió");
    expect(res).toMatchObject({ closed: true, transitioned: true });
    expect(taskRow(task.id)).toMatchObject({ subState: "queued" });
    expect(await herdr.getAgent(run.herdrName ?? "")).toBeUndefined();
  });

  it("el observador ve el Run al lanzarse y lo suelta al cerrarse", async () => {
    const watched: string[] = [];
    const released: string[] = [];
    const ctx = setup({
      dispatcher: {
        observer: {
          watch: (run) => watched.push(run.id),
          unwatch: (runId) => released.push(runId),
        },
      },
    });
    const task = insertTask(ctx.db, ctx.project.id);
    await ctx.dispatcher.dispatch(refine(task));
    await ctx.dispatcher.idle();
    const [run] = ctx.runs.forTask(task.id);
    await ctx.dispatcher.closeRun(run?.id ?? "", { result: "success" });
    expect(watched).toEqual([run?.id]);
    expect(released).toEqual([run?.id]);
  });
});

describe("PhaseDispatcher: archivo de evidencia al cerrar el Run (UW-24)", () => {
  async function withEvidence(recordRun?: (runId: string) => Promise<unknown>) {
    const calls: { runId: string; endedAt: Date | null; paneOpen: boolean }[] = [];
    const ctx = setup();
    const task = insertTask(ctx.db, ctx.project.id);
    const dispatcher = ctx.make({
      evidence: {
        recordRun: async (runId) => {
          const run = ctx.runs.get(runId);
          const snap = await ctx.herdr.snapshot();
          calls.push({
            runId,
            endedAt: run?.endedAt ?? null,
            paneOpen: snap.panes.some((p) => p.paneId === run?.herdrPane),
          });
          await recordRun?.(runId);
        },
      },
    });
    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();
    const [run] = ctx.runs.forTask(task.id);
    if (!run) throw new Error("sin Run");
    return { ...ctx, dispatcher, calls, task, run };
  }

  it("closeRun registra el Run ya cerrado y con el pane ya cerrado, para un transcript completo", async () => {
    const { dispatcher, calls, run } = await withEvidence();
    await dispatcher.closeRun(run.id, { result: "success", handoff: { a: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ runId: run.id, paneOpen: false });
    expect(calls[0]?.endedAt).toBeInstanceOf(Date);
  });

  it("closeRun sobre un Run que ya cerró el MCP también lo registra", async () => {
    const { db, dispatcher, calls, run } = await withEvidence();
    closeRun(db, run.id, { result: "success", handoff: { spec: 1 } });
    await dispatcher.closeRun(run.id, { result: "failure" });
    expect(calls.map((c) => c.runId)).toEqual([run.id]);
  });

  it("releaseRun registra el Run que cerró una tool de salida del MCP", async () => {
    const { db, dispatcher, calls, run } = await withEvidence();
    await dispatcher.releaseRun(run.id);
    expect(calls).toHaveLength(0);
    closeRun(db, run.id, { result: "success", handoff: { spec: 1 } });
    await dispatcher.releaseRun(run.id);
    expect(calls.map((c) => c.runId)).toEqual([run.id]);
  });

  it("failRun registra el Run fallido", async () => {
    const { dispatcher, calls, run } = await withEvidence();
    await dispatcher.failRun(run.id, "el agente salió");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.endedAt).toBeInstanceOf(Date);
  });

  it("un Run que falla al lanzar queda registrado", async () => {
    const calls: string[] = [];
    const ctx = setup({
      dispatcher: { evidence: { recordRun: async (id) => void calls.push(id) } },
    });
    ctx.processes.respond((c) =>
      c.command === "pnpm install" ? { exitCode: 1, stderr: "pnpm: not found" } : {},
    );
    const task = insertTask(ctx.db, ctx.project.id);
    await ctx.dispatcher.dispatch(refine(task));
    await ctx.dispatcher.idle();
    const [run] = ctx.runs.forTask(task.id);
    expect(run?.result).toBe("failure");
    expect(calls).toEqual([run?.id]);
  });

  it("un fallo al escribir la evidencia se reporta y no impide cerrar el pane ni el Run", async () => {
    const { dispatcher, herdr, errors, run, runs } = await withEvidence(async () => {
      throw new Error("disco lleno");
    });
    const res = await dispatcher.closeRun(run.id, { result: "success" });
    expect(res.closed).toBe(true);
    expect(runs.get(run.id)?.result).toBe("success");
    expect(await herdr.getAgent(run.herdrName ?? "")).toBeUndefined();
    expect(errors.map((e) => [e.runId, e.error.message])).toEqual([[run.id, "disco lleno"]]);
  });
});

describe("PhaseDispatcher: hallazgos de la revisión", () => {
  it("cerrar el Run durante el bootstrap detiene el lanzamiento sin dejar agente ni pane", async () => {
    const watched: string[] = [];
    const ctx = setup({
      dispatcher: { observer: { watch: (r) => watched.push(r.id), unwatch: () => {} } },
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.processes.respond(async (c) => {
      if (c.command === "pnpm install") await gate;
      return {};
    });
    const task = insertTask(ctx.db, ctx.project.id);
    await ctx.dispatcher.dispatch(refine(task));
    await vi.waitFor(() =>
      expect(ctx.processes.calls.some((c) => c.command === "pnpm install")).toBe(true),
    );
    const [run] = ctx.runs.forTask(task.id);
    const panesBefore = (await ctx.herdr.snapshot()).panes.length;

    await ctx.dispatcher.closeRun(run?.id ?? "", { result: "cancelled" });
    release();
    await ctx.dispatcher.idle();

    const snap = await ctx.herdr.snapshot();
    expect(snap.agents).toEqual([]);
    expect(snap.panes).toHaveLength(panesBefore);
    expect(ctx.runs.get(run?.id ?? "")).toMatchObject({ result: "cancelled", launchedAt: null });
    expect(watched).toEqual([]);
    expect(ctx.errors).toEqual([]);
  });

  it("un agente recién arrancado que aún carga se espera y recibe el prompt", async () => {
    const ctx = setup();
    const original = ctx.herdr.startAgent.bind(ctx.herdr);
    vi.spyOn(ctx.herdr, "startAgent").mockImplementationOnce(async (input) => {
      const res = await original(input);
      return { ...res, agent: { ...res.agent, status: "unknown" as const } };
    });
    const task = insertTask(ctx.db, ctx.project.id);

    await ctx.dispatcher.dispatch(refine(task));
    await ctx.dispatcher.idle();

    const [run] = ctx.runs.forTask(task.id);
    expect(await ctx.herdr.readAgent({ name: run?.herdrName ?? "" })).toBe(
      phasePrompt("refine", task.id),
    );
  });

  it("un agente reutilizado bloqueado por un permiso no se mata al retomar", async () => {
    const herdr = new FakeHerdr({ promptDurationMs: 60_000 });
    const ctx = setup({ herdr });
    const task = insertTask(ctx.db, ctx.project.id);
    const original = herdr.promptAgent.bind(herdr);
    vi.spyOn(herdr, "promptAgent").mockImplementationOnce(async (input) => {
      await original(input);
      return new Promise(() => {});
    });
    await ctx.dispatcher.dispatch(refine(task));
    await vi.waitFor(async () =>
      expect((await herdr.snapshot()).agents[0]?.status).toBe("working"),
    );
    const name = ctx.runs.forTask(task.id)[0]?.herdrName ?? "";
    herdr.setAgentStatus(name, "blocked");

    const restarted = ctx.make();
    await restarted.recover();
    await restarted.idle();

    expect(ctx.runs.forTask(task.id)[0]).toMatchObject({ result: null });
    expect(ctx.runs.forTask(task.id)[0]?.launchedAt).toBeInstanceOf(Date);
    expect(await herdr.getAgent(name)).toBeDefined();
  });

  it("un pane guardado que ya no es del worktree no se reutiliza ni se cierra", async () => {
    const ctx = setup();
    const task = insertTask(ctx.db, ctx.project.id);
    const res = claimRun(ctx.db, {
      decision: refine(task),
      config: SchedulerConfig.parse({}),
      projects: new ProjectRepository(ctx.db),
      sessionId: "s",
    });
    if (!res.ok) throw new Error(res.error.message);
    // Tras un reinicio de herdr el id guardado nombra un pane ajeno.
    const { rootPaneId } = await ctx.herdr.ensureWorkspace({ cwd: "/ajeno", label: "ajeno" });
    const foreign = await ctx.herdr.splitPane({ paneId: rootPaneId });
    ctx.runs.recordPane(res.run.id, { workspaceId: foreign.workspaceId, paneId: foreign.paneId });

    await ctx.dispatcher.recover();
    await ctx.dispatcher.idle();
    const run = ctx.runs.get(res.run.id);
    expect(run?.herdrPane).not.toBe(foreign.paneId);
    await ctx.dispatcher.closeRun(res.run.id, { result: "success" });
    expect((await ctx.herdr.snapshot()).panes.map((p) => p.paneId)).toContain(foreign.paneId);
  });

  it("si failRun falla al lanzar, se reportan los dos errores", async () => {
    const ctx = setup();
    ctx.processes.respond((c) => (c.command === "pnpm install" ? { exitCode: 1 } : {}));
    const fail = vi.spyOn(RunRepository.prototype, "fail").mockImplementationOnce(() => {
      throw new Error("base caída");
    });
    await ctx.dispatcher.dispatch(refine(insertTask(ctx.db, ctx.project.id)));
    await ctx.dispatcher.idle();
    fail.mockRestore();
    expect(ctx.errors.map((e) => e.error.message)).toEqual([
      "base caída",
      expect.stringContaining("bootstrap"),
    ]);
  });
});

describe("PhaseDispatcher con el Scheduler", () => {
  it("una pasada despacha hasta el límite global y la siguiente no duplica", async () => {
    const { db, project, herdr, dispatcher } = setup({ config: { globalConcurrency: 1 } });
    insertTask(db, project.id, { priority: 100 });
    insertTask(db, project.id, { priority: 900 });
    const scheduler = new Scheduler({ db, dispatcher, config: { globalConcurrency: 1 } });
    stoppables.push(scheduler);

    const first = await scheduler.run();
    const second = await scheduler.run();
    await dispatcher.idle();

    expect(first.dispatched).toHaveLength(1);
    expect(second.dispatched).toEqual([]);
    expect((await herdr.snapshot()).agents).toHaveLength(1);
  });
});
