import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_TRUST_ACCEPT_KEYS,
  FakeHerdr,
  FakeProcessRunner,
  TRUST_ACCEPT_KEYS,
} from "@lunasq/adapters";
import {
  appendEvent,
  claimRun,
  closeRun,
  ProjectRepository,
  ProjectWorkspaceRepository,
  RunRepository,
  SettingsRepository,
  TaskWorktreeRepository,
  transitionTask,
} from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { agentName, type DispatchDecision, phasePrompt } from "@lunasq/domain";
import {
  HOOK_POINT_COMPLETED,
  type HookPoint,
  type Project,
  RUN_FAILED,
  SchedulerConfig,
  type SchedulerConfigInput,
} from "@lunasq/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhaseHookInput, PhaseHookResult, PhaseHooks } from "../mcp/ports.ts";
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
      throw new Error("did not throw");
    },
    (err: unknown) => err,
  );
}

describe("PhaseDispatcher: end-to-end dispatch", () => {
  it("launches Copilot with a per-Run tokenized MCP and without Claude telemetry environment", async () => {
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
      "--autopilot",
      "--allow-all-tools",
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

  it("claims, prepares the worktree, brings up the agent with its environment and sends it the phase", async () => {
    const { db, project, herdr, dispatcher, runs, taskRow, errors, workspaces } = setup();
    const task = insertTask(db, project.id);

    await dispatcher.dispatch(refine(task));
    // On resolving, the claim is already confirmed: the task occupies its slot.
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
    // The pane title identifies the task by its number; branch and agent continue with the UUID.
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

    // The pane opens in the task's worktree, inside the worktree's workspace.
    const row = taskRow(task.id);
    const snap = await herdr.snapshot();
    expect(snap.panes.find((p) => p.paneId === run.herdrPane)?.cwd).toBe(row?.worktreePath);
    expect(workspaces.get(project.id)).not.toBeNull();
  });

  it("paneEnv overrides the pane defaults, like CLAUDE_CODE_FORK_SUBAGENT", async () => {
    const { db, project, herdr, dispatcher, runs } = setup({
      dispatcher: { paneEnv: { CLAUDE_CODE_FORK_SUBAGENT: "1" } },
    });
    const task = insertTask(db, project.id);
    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();
    const [run] = runs.forTask(task.id);
    expect(herdr.paneEnv(run?.herdrPane ?? "")).toMatchObject({ CLAUDE_CODE_FORK_SUBAGENT: "1" });
  });

  it("with telemetry on, the pane carries the Run attributes and the run token as an OTLP header", async () => {
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

  it("with telemetry off, the pane carries no OTEL variables", async () => {
    const { db, project, herdr, dispatcher, runs } = setup();
    const task = insertTask(db, project.id);
    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();
    const [run] = runs.forTask(task.id);
    const env = herdr.paneEnv(run?.herdrPane ?? "");
    expect(Object.keys(env).filter((k) => k.startsWith("OTEL_"))).toEqual([]);
  });

  it("repeating the dispatch does not duplicate agents or panes", async () => {
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

  it("rejects without touching herdr if there is no slot", async () => {
    const { db, project, herdr, dispatcher } = setup({ concurrency: 1 });
    await dispatcher.dispatch(refine(insertTask(db, project.id)));
    const spy = vi.spyOn(herdr, "splitPane");

    const err = await rejection(dispatcher.dispatch(refine(insertTask(db, project.id))));

    expect(isDispatchError(err, "no_slot")).toBe(true);
    await dispatcher.idle();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("PhaseDispatcher: resuming a half-done dispatch", () => {
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

  it("recover launches the claimed Runs that never launched, once", async () => {
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

  it("if the process crashed with the agent already started, it reuses it instead of opening another", async () => {
    const ctx = setup();
    const task = insertTask(ctx.db, ctx.project.id);
    // First process: hangs right after starting the agent.
    vi.spyOn(ctx.herdr, "reportMetadata").mockImplementationOnce(() => new Promise(() => {}));
    await ctx.dispatcher.dispatch(refine(task));
    await vi.waitFor(async () => expect((await ctx.herdr.snapshot()).agents).toHaveLength(1));
    const panes = (await ctx.herdr.snapshot()).panes.length;

    // Second process (restart): resumes the same Run.
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

  it("if a provider's initialization was interrupted, it continues with the next one", async () => {
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

  it("if it crashed after the prompt, it does not repeat it: the agent is no longer idle", async () => {
    const herdr = new FakeHerdr({ promptDurationMs: 60_000 });
    const ctx = setup({ herdr });
    const task = insertTask(ctx.db, ctx.project.id);
    const original = herdr.promptAgent.bind(herdr);
    // First process: the prompt reaches the agent and the process crashes before marking the launch.
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

describe("PhaseDispatcher: folder trust", () => {
  it("accepts the dialog with down enter and continues with the prompt", async () => {
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

  it("accepts Copilot's trust dialog without activating fallback to Claude", async () => {
    const herdr = new FakeHerdr({ startStatus: "blocked" });
    const { db, project, dispatcher, runs, errors } = setup({
      herdr,
      agentProfiles: { refine: { kind: "copilot", args: [] } },
    });
    const task = insertTask(db, project.id);

    await dispatcher.dispatch({ ...refine(task), agentKind: "copilot" });
    await dispatcher.idle();

    const [run] = runs.forTask(task.id);
    const name = run?.herdrName ?? "";
    expect(errors).toEqual([]);
    expect(run).toMatchObject({ agentKind: "copilot", launchedAt: expect.any(Date) });
    expect(herdr.sentKeys(name)).toEqual([["enter"]]);
    expect(await herdr.readAgent({ name })).toBe(phasePrompt("refine", task.id));
  });

  it("accepts Codex's trust dialog and launches it with run-scoped MCP configuration", async () => {
    const herdr = new FakeHerdr({ startStatus: "blocked" });
    const { db, project, dispatcher, runs, errors } = setup({
      herdr,
      agentProfiles: { refine: { kind: "codex", model: "gpt-5.4", effort: "high", args: [] } },
    });
    const task = insertTask(db, project.id);
    const starts: Parameters<typeof herdr.startAgent>[0][] = [];
    const start = herdr.startAgent.bind(herdr);
    vi.spyOn(herdr, "startAgent").mockImplementation(async (input) => {
      starts.push(input);
      return start(input);
    });

    await dispatcher.dispatch({ ...refine(task), agentKind: "codex" });
    await dispatcher.idle();

    const run = runs.forTask(task.id)[0];
    const name = run?.herdrName ?? "";
    const args = starts[0]?.args ?? [];
    expect(errors).toEqual([]);
    expect(run).toMatchObject({ agentKind: "codex", launchedAt: expect.any(Date) });
    expect(herdr.sentKeys(name)).toEqual([[...CODEX_TRUST_ACCEPT_KEYS]]);
    expect(args).toContain("--sandbox");
    expect(args).toContain('mcp_servers.lunasq.url="http://127.0.0.1:8123/mcp"');
    expect(args).toContain(
      'mcp_servers.lunasq.env_http_headers={"X-LunasQ-Run-Token"="LUNASQ_RUN_TOKEN"}',
    );
    expect(args).toContain('mcp_servers.lunasq.default_tools_approval_mode="approve"');
    expect(args.join(" ")).not.toContain(run?.runToken);
  });

  it("a blockage that is not the trust dialog fails the Run without sending keys", async () => {
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

describe("PhaseDispatcher: enabled providers", () => {
  it("with claude disabled it only tries copilot and does not record an attempt for claude", async () => {
    const { db, project, herdr, dispatcher, runs } = setup();
    const task = insertTask(db, project.id);
    new SettingsRepository(db).saveProviders({ claude: false, copilot: true, codex: false });
    const kinds: string[] = [];
    const start = herdr.startAgent.bind(herdr);
    vi.spyOn(herdr, "startAgent").mockImplementation(async (input) => {
      kinds.push(input.kind);
      return start(input);
    });

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    const [run] = runs.forTask(task.id);
    expect(kinds).toEqual(["copilot"]);
    expect(run?.agentKind).toBe("copilot");
    expect(runs.providerAttempts(run?.id ?? "")).toEqual([
      { provider: "copilot", status: "started" },
    ]);
  });

  it("if the only enabled one fails to start, it does not fall back to a disabled provider", async () => {
    const { db, project, herdr, dispatcher, runs, taskRow } = setup();
    const task = insertTask(db, project.id);
    new SettingsRepository(db).saveProviders({ claude: false, copilot: true, codex: false });
    const kinds: string[] = [];
    vi.spyOn(herdr, "startAgent").mockImplementation(async (input) => {
      kinds.push(input.kind);
      throw new Error(`${input.kind} service unavailable`);
    });

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    expect(kinds).toEqual(["copilot"]);
    expect(runs.forTask(task.id)[0]?.failureReason).toContain(
      "copilot: copilot service unavailable",
    );
    expect(taskRow(task.id)).toMatchObject({ state: "needs_human" });
  });

  it("if claude is disabled while the launch is being prepared, it does not start it, but falls back to copilot", async () => {
    const { db, project, herdr, dispatcher, runs } = setup();
    const task = insertTask(db, project.id);
    const kinds: string[] = [];
    const start = herdr.startAgent.bind(herdr);
    vi.spyOn(herdr, "startAgent").mockImplementation(async (input) => {
      kinds.push(input.kind);
      return start(input);
    });
    const closed: string[] = [];
    const close = herdr.closePane.bind(herdr);
    vi.spyOn(herdr, "closePane").mockImplementation(async (paneId) => {
      closed.push(paneId);
      return close(paneId);
    });
    // The human turns claude off after the claim, while the dispatcher prepares the pane.
    const split = herdr.splitPane.bind(herdr);
    let disabled = false;
    vi.spyOn(herdr, "splitPane").mockImplementation(async (input) => {
      if (!disabled) {
        disabled = true;
        new SettingsRepository(db).saveProviders({ claude: false });
      }
      return split(input);
    });

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    const [run] = runs.forTask(task.id);
    expect(kinds).toEqual(["copilot"]);
    expect(run?.agentKind).toBe("copilot");
    expect(runs.providerAttempts(run?.id ?? "")).toEqual([
      { provider: "copilot", status: "started" },
    ]);
    // The pane prepared for claude is not left orphaned: it is closed and only copilot's stays open.
    expect(closed).toHaveLength(1);
    const { panes } = await herdr.snapshot();
    expect(panes.some((p) => p.paneId === closed[0])).toBe(false);
    expect(panes.some((p) => p.paneId === run?.herdrPane)).toBe(true);
  });

  it("if all are disabled while the launch is being prepared, nothing starts and the task goes back to queued", async () => {
    const { db, project, herdr, dispatcher, runs, taskRow } = setup();
    const task = insertTask(db, project.id);
    const startAgent = vi.spyOn(herdr, "startAgent");
    const split = herdr.splitPane.bind(herdr);
    let disabled = false;
    vi.spyOn(herdr, "splitPane").mockImplementation(async (input) => {
      if (!disabled) {
        disabled = true;
        new SettingsRepository(db).saveProviders({ claude: false, copilot: false, codex: false });
      }
      return split(input);
    });

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    expect(startAgent).not.toHaveBeenCalled();
    // It is a pause, not a failure: the task waits in queued and the Run does not count as failed.
    expect(taskRow(task.id)).toMatchObject({ state: "draft", subState: "queued" });
    const [run] = runs.forTask(task.id);
    expect(run).toMatchObject({ result: "cancelled" });
    expect(run?.failureReason).toContain("disabled");
    expect(runs.consecutiveFailures(task.id, "refine")).toBe(0);
    const { panes } = await herdr.snapshot();
    expect(panes.some((p) => p.paneId === run?.herdrPane)).toBe(false);

    // When one is enabled, the task is dispatched normally.
    new SettingsRepository(db).saveProviders({ copilot: true, codex: false });
    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();
    expect(runs.forTask(task.id).at(-1)).toMatchObject({ agentKind: "copilot", endedAt: null });
  });

  it("rejects the claim if all providers were disabled after planning and the task stays in queued", async () => {
    const { db, project, dispatcher, runs, taskRow } = setup();
    const task = insertTask(db, project.id);
    const decision = refine(task);
    new SettingsRepository(db).saveProviders({ claude: false, copilot: false, codex: false });

    await expect(dispatcher.dispatch(decision)).rejects.toMatchObject({
      code: "providers_disabled",
    });

    expect(taskRow(task.id)).toMatchObject({ state: "draft", subState: "queued" });
    expect(runs.forTask(task.id)).toEqual([]);
  });

  it("disabling claude does not interrupt a live agent, keeps its slot and the new task goes to the enabled one", async () => {
    // With one slot per kind, if the live agent stopped counting when claude is turned off, or the claim
    // kept counting it on the profile's provider, the new task would not fit or would step on the slot.
    const { db, project, herdr, dispatcher, runs, taskRow } = setup({
      config: { agentKindConcurrency: { claude: 1, copilot: 1 } },
    });
    const viva = insertTask(db, project.id);
    await dispatcher.dispatch(refine(viva));
    await dispatcher.idle();
    const [vivaRun] = runs.forTask(viva.id);
    expect(vivaRun).toMatchObject({ agentKind: "claude", endedAt: null });
    const closed: string[] = [];
    const close = herdr.closePane.bind(herdr);
    vi.spyOn(herdr, "closePane").mockImplementation(async (paneId) => {
      closed.push(paneId);
      return close(paneId);
    });

    new SettingsRepository(db).saveProviders({ claude: false });
    // Reconciliation runs after the change: it must not treat the agent of a turned-off provider
    // as an orphan nor restart it.
    await dispatcher.recover();
    await dispatcher.idle();
    const nueva = insertTask(db, project.id);
    await dispatcher.dispatch(refine(nueva));
    await dispatcher.idle();

    expect(closed).toEqual([]);
    expect(runs.get(vivaRun?.id ?? "")).toMatchObject({ endedAt: null, agentKind: "claude" });
    expect(taskRow(viva.id)).toMatchObject({ subState: "running" });
    const snapshot = await herdr.snapshot();
    expect(snapshot.agents.some((a) => a.paneId === vivaRun?.herdrPane)).toBe(true);
    expect(runs.forTask(nueva.id)[0]).toMatchObject({ agentKind: "copilot", endedAt: null });
  });
});

describe("PhaseDispatcher: launch failures", () => {
  it("switches to the next provider when the primary CLI does not start", async () => {
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

  it("does not move to a fallback whose concurrency limit is already full and counts the primary's failure", async () => {
    const { db, project, herdr, dispatcher, runs, taskRow } = setup({
      config: { agentKindConcurrency: { copilot: 1 } },
    });
    const settings = new SettingsRepository(db);
    // A live copilot agent fills its only slot (claude was off when it was dispatched).
    settings.saveProviders({ claude: false, copilot: true, codex: false });
    const live = insertTask(db, project.id);
    await dispatcher.dispatch(refine(live));
    await dispatcher.idle();
    settings.saveProviders({ claude: true, copilot: true, codex: false });
    const kinds: string[] = [];
    const start = herdr.startAgent.bind(herdr);
    vi.spyOn(herdr, "startAgent").mockImplementation(async (input) => {
      kinds.push(input.kind);
      if (input.kind === "claude") throw new Error("claude executable not found");
      return start(input);
    });
    const task = insertTask(db, project.id);

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    const [run] = runs.forTask(task.id);
    expect(kinds).toEqual(["claude"]);
    expect(run?.agentKind).toBe("claude");
    // Claude's real failure is counted: pausing would hide it and the scheduler would dispatch again
    // to the broken provider without backoff. The diagnosis keeps both reasons.
    expect(run).toMatchObject({ result: "failure" });
    expect(run?.failureReason).toContain("claude: claude executable not found");
    expect(run?.failureReason).toContain("copilot: no concurrency slot");
    expect(taskRow(task.id)).not.toMatchObject({ subState: "queued" });
    expect(runs.forTask(live.id)[0]?.agentKind).toBe("copilot");
  });

  it("applies a symmetric fallback when Copilot is the primary provider", async () => {
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

  it("goes to needs_human and keeps both diagnoses if no CLI responds", async () => {
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
        "no provider responded on start: claude: claude service unavailable; copilot: copilot service unavailable; codex: codex service unavailable",
      ),
    });
    expect(taskRow(task.id)).toMatchObject({ state: "needs_human", subState: null });
    expect(
      runs.providerAttempts(run?.id ?? "").filter((attempt) => attempt.status === "failed"),
    ).toHaveLength(3);
  });

  it("a failing bootstrap closes the Run as failure and returns the task to queued", async () => {
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

  it("an agent name taken by another Run fails instead of adopting it", async () => {
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

describe("PhaseDispatcher: phase close", () => {
  async function launched() {
    const ctx = setup();
    const task = insertTask(ctx.db, ctx.project.id);
    await ctx.dispatcher.dispatch(refine(task));
    await ctx.dispatcher.idle();
    const [run] = ctx.runs.forTask(task.id);
    if (!run) throw new Error("sin Run");
    return { ...ctx, task, run };
  }

  it("closeRun stores result, handoff and session, and closes the pane", async () => {
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

  it("closeRun on a Run the MCP already closed only cleans the pane", async () => {
    const { db, dispatcher, herdr, run, runs } = await launched();
    closeRun(db, run.id, { result: "success", handoff: { spec: 1 } });

    const res = await dispatcher.closeRun(run.id, { result: "failure" });

    expect(res.closed).toBe(false);
    expect(runs.get(run.id)).toMatchObject({ result: "success", handoff: { spec: 1 } });
    expect(await herdr.getAgent(run.herdrName ?? "")).toBeUndefined();
  });

  it("closeRun is idempotent", async () => {
    const { dispatcher, run, runs } = await launched();
    await dispatcher.closeRun(run.id, { result: "success" });
    const again = await dispatcher.closeRun(run.id, { result: "failure" });
    expect(again.closed).toBe(false);
    expect(runs.get(run.id)?.result).toBe("success");
  });

  it("closeRun uses the herdr session if the Run has no native one", async () => {
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

  it("failRun closes the pane and returns the task to queued", async () => {
    const { dispatcher, herdr, run, task, taskRow } = await launched();
    const res = await dispatcher.failRun(run.id, "el agente salió");
    expect(res).toMatchObject({ closed: true, transitioned: true });
    expect(taskRow(task.id)).toMatchObject({ subState: "queued" });
    expect(await herdr.getAgent(run.herdrName ?? "")).toBeUndefined();
  });

  it("the observer sees the Run on launch and drops it on close", async () => {
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

describe("PhaseDispatcher: evidence file on closing the Run", () => {
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

  it("closeRun records the Run already closed and with the pane already closed, for a complete transcript", async () => {
    const { dispatcher, calls, run } = await withEvidence();
    await dispatcher.closeRun(run.id, { result: "success", handoff: { a: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ runId: run.id, paneOpen: false });
    expect(calls[0]?.endedAt).toBeInstanceOf(Date);
  });

  it("closeRun on a Run the MCP already closed also records it", async () => {
    const { db, dispatcher, calls, run } = await withEvidence();
    closeRun(db, run.id, { result: "success", handoff: { spec: 1 } });
    await dispatcher.closeRun(run.id, { result: "failure" });
    expect(calls.map((c) => c.runId)).toEqual([run.id]);
  });

  it("releaseRun records the Run that an MCP exit tool closed", async () => {
    const { db, dispatcher, calls, run } = await withEvidence();
    await dispatcher.releaseRun(run.id);
    expect(calls).toHaveLength(0);
    closeRun(db, run.id, { result: "success", handoff: { spec: 1 } });
    await dispatcher.releaseRun(run.id);
    expect(calls.map((c) => c.runId)).toEqual([run.id]);
  });

  it("failRun records the failed Run", async () => {
    const { dispatcher, calls, run } = await withEvidence();
    await dispatcher.failRun(run.id, "el agente salió");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.endedAt).toBeInstanceOf(Date);
  });

  it("a Run that fails on launch is recorded", async () => {
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

  it("a failure writing the evidence is reported and does not prevent closing the pane or the Run", async () => {
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

describe("PhaseDispatcher: review findings", () => {
  it("closing the Run during the bootstrap stops the launch without leaving an agent or pane", async () => {
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

  it("a freshly started agent that is still loading is waited for and receives the prompt", async () => {
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

  it("a reused agent blocked by a permission is not killed on resuming", async () => {
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

  it("a saved pane that is no longer the worktree's is neither reused nor closed", async () => {
    const ctx = setup();
    const task = insertTask(ctx.db, ctx.project.id);
    const res = claimRun(ctx.db, {
      decision: refine(task),
      config: SchedulerConfig.parse({}),
      projects: new ProjectRepository(ctx.db),
      sessionId: "s",
    });
    if (!res.ok) throw new Error(res.error.message);
    // After a herdr restart the saved id names a foreign pane.
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

  it("if failRun fails on launch, both errors are reported", async () => {
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

describe("PhaseDispatcher with the Scheduler", () => {
  it("one pass dispatches up to the global limit and the next does not duplicate", async () => {
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

describe("PhaseDispatcher: before_refinement and before_implementation hooks", () => {
  const passed: PhaseHookResult = {
    outcome: "passed",
    escalated: false,
    failedScript: null,
    error: null,
  };

  /** A HookService stand-in: records the calls and the herdr agents already started at each one. */
  function hooksSetup(
    ctx: ReturnType<typeof setup>,
    result: (input: PhaseHookInput) => PhaseHookResult = () => passed,
  ) {
    const calls: { input: PhaseHookInput; agentsStarted: number }[] = [];
    const hooks: PhaseHooks = {
      run: async (input) => {
        calls.push({ input, agentsStarted: (await ctx.herdr.snapshot()).agents.length });
        const res = result(input);
        if (res.outcome === "blocked") {
          // What HookService does when a point with block policy fails.
          transitionTask(ctx.db, {
            taskId: input.taskId,
            actor: "system",
            command: { type: "escalate", reason: "hook_failed" },
          });
        }
        return res;
      },
    };
    return { hooks, calls };
  }

  const blocked: PhaseHookResult = {
    outcome: "blocked",
    escalated: true,
    failedScript: "10-check.sh",
    error: null,
  };

  const implement = (task: { id: string; projectId: string }): DispatchDecision => ({
    ...refine(task),
    phase: "implement",
    expected: { state: "in_progress", subState: "queued" },
  });

  function implementReady(ctx: ReturnType<typeof setup>) {
    return insertTask(ctx.db, ctx.project.id, { state: "in_progress" });
  }

  it("runs before_refinement with the Run id before the agent is started and prompted", async () => {
    const ctx = setup();
    const { hooks, calls } = hooksSetup(ctx);
    const dispatcher = ctx.make({ hooks });
    const task = insertTask(ctx.db, ctx.project.id);

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    const [run] = ctx.runs.forTask(task.id);
    expect(calls).toEqual([
      {
        input: { taskId: task.id, point: "before_refinement", runId: run?.id },
        agentsStarted: 0,
      },
    ]);
    expect(await ctx.herdr.readAgent({ name: run?.herdrName ?? "" })).toBe(
      phasePrompt("refine", task.id),
    );
    expect(ctx.errors).toEqual([]);
  });

  it("runs before_implementation before the implement agent is started", async () => {
    const ctx = setup();
    const { hooks, calls } = hooksSetup(ctx);
    const dispatcher = ctx.make({ hooks });
    const task = implementReady(ctx);

    await dispatcher.dispatch(implement(task));
    await dispatcher.idle();

    const [run] = ctx.runs.forTask(task.id);
    expect(calls).toEqual([
      {
        input: { taskId: task.id, point: "before_implementation", runId: run?.id },
        agentsStarted: 0,
      },
    ]);
    expect((await ctx.herdr.snapshot()).agents).toHaveLength(1);
  });

  it.each([
    ["before_refinement", "refine"],
    ["before_implementation", "implement"],
  ] as const)(
    "a blocked %s starts no agent, cancels the Run with hook_blocked and spends no retry",
    async (point, phase) => {
      const ctx = setup();
      const { hooks, calls } = hooksSetup(ctx, () => blocked);
      const dispatcher = ctx.make({ hooks });
      const task = phase === "refine" ? insertTask(ctx.db, ctx.project.id) : implementReady(ctx);

      await dispatcher.dispatch(phase === "refine" ? refine(task) : implement(task));
      await dispatcher.idle();

      const [run] = ctx.runs.forTask(task.id);
      expect(calls.map((c) => c.input.point)).toEqual([point]);
      expect(run).toMatchObject({ result: "cancelled" });
      expect(run?.failureReason).toMatch(/^hook_blocked/);
      expect(run?.failureReason).toContain("10-check.sh");
      expect(ctx.taskRow(task.id)).toMatchObject({ state: "needs_human", subState: null });
      expect((await ctx.herdr.snapshot()).agents).toEqual([]);
      expect(ctx.runs.consecutiveFailures(task.id, phase)).toBe(0);
      const failed = ctx.db.$client
        .prepare("select count(*) as n from events where task_id = ? and type = ?")
        .get(task.id, RUN_FAILED) as { n: number };
      expect(failed.n).toBe(0);
      expect(ctx.errors).toEqual([]);
    },
  );

  it("a warned before_implementation still starts and prompts the agent", async () => {
    const ctx = setup();
    const { hooks } = hooksSetup(ctx, () => ({ ...passed, outcome: "warned" }));
    const dispatcher = ctx.make({ hooks });
    const task = implementReady(ctx);

    await dispatcher.dispatch(implement(task));
    await dispatcher.idle();

    const [run] = ctx.runs.forTask(task.id);
    expect(run).toMatchObject({ result: null });
    expect(run?.launchedAt).toBeInstanceOf(Date);
    expect(await ctx.herdr.readAgent({ name: run?.herdrName ?? "" })).toBe(
      phasePrompt("implement", task.id),
    );
  });

  it.each(["passed", "warned"] as const)(
    "a recovered launch does not run again a point that already completed as %s for the Run",
    async (outcome) => {
      const ctx = setup();
      const { hooks, calls } = hooksSetup(ctx);
      const task = insertTask(ctx.db, ctx.project.id);
      const claim = claimRun(ctx.db, {
        decision: refine(task),
        config: SchedulerConfig.parse({}),
        projects: new ProjectRepository(ctx.db),
        sessionId: "sess-crash",
      });
      if (!claim.ok) throw new Error(claim.error.message);
      appendEvent(ctx.db, {
        taskId: task.id,
        type: HOOK_POINT_COMPLETED,
        actor: "system",
        payload: {
          point: "before_refinement" satisfies HookPoint,
          baseRef: "a".repeat(40),
          runId: claim.run.id,
          outcome,
          failedScript: null,
          error: null,
          commit: null,
          commitSkipped: false,
        },
      });
      const restarted = ctx.make({ hooks });

      await restarted.recover();
      await restarted.idle();

      expect(calls).toEqual([]);
      expect(ctx.runs.get(claim.run.id)?.launchedAt).toBeInstanceOf(Date);
      expect((await ctx.herdr.snapshot()).agents).toHaveLength(1);
    },
  );

  it("a point that completed for another Run of the task does run for this one", async () => {
    const ctx = setup();
    const { hooks, calls } = hooksSetup(ctx);
    const task = insertTask(ctx.db, ctx.project.id);
    appendEvent(ctx.db, {
      taskId: task.id,
      type: HOOK_POINT_COMPLETED,
      actor: "system",
      payload: {
        point: "before_refinement",
        baseRef: "a".repeat(40),
        runId: "another-run",
        outcome: "passed",
        failedScript: null,
        error: null,
        commit: null,
        commitSkipped: false,
      },
    });
    const dispatcher = ctx.make({ hooks });

    await dispatcher.dispatch(refine(task));
    await dispatcher.idle();

    expect(calls).toHaveLength(1);
  });

  it("a dispatcher without hooks launches as before", async () => {
    const ctx = setup();
    const task = insertTask(ctx.db, ctx.project.id);

    await ctx.dispatcher.dispatch(refine(task));
    await ctx.dispatcher.idle();

    expect(ctx.runs.forTask(task.id)[0]?.launchedAt).toBeInstanceOf(Date);
    expect(ctx.errors).toEqual([]);
  });
});
