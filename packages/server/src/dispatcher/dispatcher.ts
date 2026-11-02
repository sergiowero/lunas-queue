// Dispatcher (docs/design.md §Dispatch sequence, ADR 0002, ADR 0004, ADR 0014, ADR
// uw-16-dispatcher). Implements the scheduler's `Dispatcher` port: the claim is atomic in the
// database and the rest of the sequence (worktree, pane, agent, trust, metadata, prompt) runs
// afterwards, in the background, saving each step in the Run. This way a dispatch that falls halfway is
// resumed without duplicating panes or agents, and repeating an already applied decision gives `stale_state`.
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentProviderError,
  agentProviders,
  COPILOT_TRUST_ACCEPT_KEYS,
  type HerdrAdapter,
  type HerdrAgent,
  isHerdrError,
  showsCopilotTrustDialog,
  showsTrustDialog,
  TRUST_ACCEPT_KEYS,
} from "@lunasq/adapters";
import {
  type ClaimErrorCode,
  type CloseRunInput,
  claimRun,
  type FailRunResult,
  type LunasqDatabase,
  ProjectRepository,
  type ProviderSettingsReader,
  RunRepository,
  type RunRow,
  SettingsRepository,
  TaskWorktreeRepository,
} from "@lunasq/db";
import {
  type DispatchDecision,
  DispatchRuleError,
  type ProjectConfigReader,
  phaseProfile,
  phasePrompt,
  resolveSession,
  runEnv,
  type TaskWorktreeRecord,
  telemetryRunEnv,
} from "@lunasq/domain";
import {
  type AgentKind,
  type Project,
  type SchedulablePhase,
  SchedulablePhase as SchedulablePhaseSchema,
  SchedulerConfig,
  type SchedulerConfigInput,
  taskLabel,
} from "@lunasq/schemas";
import { DEFAULT_GATE_TIMEOUT_MS } from "../mcp/ports.ts";
import type { Dispatcher } from "../scheduler/scheduler.ts";
import { KeyedLock } from "../worktrees/keyed-lock.ts";
import { isWorktreeError, type WorktreeService } from "../worktrees/service.ts";

/** How long to wait for Claude Code to be ready after accepting folder trust. */
export const DEFAULT_TRUST_TIMEOUT_MS = 15_000;
/**
 * Claude Code's `MCP_TOOL_TIMEOUT` in the pane: `submit_for_verification` and a `submit_verdict`
 * with pass run the test gate inside the call (ADR uw-11-gate-tests), so it must
 * cover its timeout with margin.
 */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = DEFAULT_GATE_TIMEOUT_MS + 5 * 60_000;
/** `--timeout` of `agent start`: how long the agent takes to be ready for prompts. */
export const DEFAULT_START_TIMEOUT_MS = 30_000;
/** Lines of the agent's screen read to recognize the trust dialog. */
const SCREEN_LINES = 60;

export type DispatchErrorCode =
  | ClaimErrorCode
  | "run_not_found"
  | "agent_blocked"
  | "agent_name_taken"
  | "profile_conflict";

export class DispatchError extends Error {
  readonly code: DispatchErrorCode;

  constructor(code: DispatchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DispatchError";
    this.code = code;
  }
}

export function isDispatchError(err: unknown, code?: DispatchErrorCode): err is DispatchError {
  return err instanceof DispatchError && (code === undefined || err.code === code);
}

/**
 * Whoever observes the live agents (UW-17: herdr signals, nudges, phase timeout). The
 * dispatcher only reports when each Run starts and when it ends.
 */
export interface RunObserver {
  watch(run: RunRow, agent: HerdrAgent): void;
  unwatch(runId: string): void;
}

/**
 * Whoever records a closed Run (the evidence file, UW-24). The dispatcher calls it
 * for each Run it closes or already finds closed; it must be idempotent.
 */
export interface RunEvidenceSink {
  recordRun(runId: string): Promise<unknown>;
}

/** `runId` is null if the failure is not a Run's (e.g. reading in `recover`). */
export type DispatchErrorHandler = (error: Error, runId: string | null) => void;

export interface PhaseDispatcherOptions {
  db: LunasqDatabase;
  herdr: HerdrAdapter;
  worktrees: WorktreeService;
  /** Stable MCP file with `${LUNASQ_RUN_TOKEN}` (ADR 0002); see `ensureMcpConfig`. */
  mcpConfigPath: string;
  /** Local URL of the LunasQ MCP to generate each Run's Copilot configuration. */
  mcpUrl?: string;
  /** Stable settings with the subagent hooks (ADR uw-19-revisores); see `ensureHookSettings`. */
  hookSettingsPath: string;
  projects?: ProjectConfigReader;
  /** Enabled providers; by default those in the database. Read on claim and on launch. */
  settings?: ProviderSettingsReader;
  /** The same limits as the scheduler: the claim revalidates them (ADR 0014). */
  config?: SchedulerConfigInput;
  /** Extra variables of each agent's pane (telemetry, test PATH). */
  paneEnv?: Record<string, string>;
  observer?: RunObserver;
  /** Without it no evidence is written. A failure writing it is reported in `onError`. */
  evidence?: RunEvidenceSink;
  newSessionId?: () => string;
  startTimeoutMs?: number;
  trustTimeoutMs?: number;
  onError?: DispatchErrorHandler;
}

export class PhaseDispatcher implements Dispatcher {
  private readonly db: LunasqDatabase;
  private readonly herdr: HerdrAdapter;
  private readonly worktrees: WorktreeService;
  private readonly mcpConfigPath: string;
  private readonly mcpUrl: string | undefined;
  private readonly copilotMcpDirs = new Map<string, string>();
  private readonly hookSettingsPath: string;
  private readonly projects: ProjectConfigReader;
  private readonly settings: ProviderSettingsReader;
  private readonly config: SchedulerConfig;
  private readonly paneEnv: Record<string, string>;
  private readonly observer: RunObserver | undefined;
  private readonly evidence: RunEvidenceSink | undefined;
  private readonly newSessionId: () => string;
  private readonly startTimeoutMs: number;
  private readonly trustTimeoutMs: number;
  private readonly onError: DispatchErrorHandler;
  private readonly runs: RunRepository;
  private readonly tasks: TaskWorktreeRepository;
  /** One launch per Run at a time: `recover` and `dispatch` may coincide. */
  private readonly locks = new KeyedLock();
  /** Closes of the same Run in order; they do not wait for the launch (it can take minutes). */
  private readonly closeLocks = new KeyedLock();
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Runs with a background launch in progress. */
  private readonly launching = new Set<string>();

  constructor(opts: PhaseDispatcherOptions) {
    this.db = opts.db;
    this.herdr = opts.herdr;
    this.worktrees = opts.worktrees;
    this.mcpConfigPath = opts.mcpConfigPath;
    this.mcpUrl = opts.mcpUrl;
    this.hookSettingsPath = opts.hookSettingsPath;
    this.projects = opts.projects ?? new ProjectRepository(opts.db);
    this.settings = opts.settings ?? new SettingsRepository(opts.db);
    this.config = SchedulerConfig.parse(opts.config ?? {});
    this.paneEnv = {
      ...opts.paneEnv,
    };
    this.observer = opts.observer;
    this.evidence = opts.evidence;
    this.newSessionId = opts.newSessionId ?? randomUUID;
    this.startTimeoutMs = opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.trustTimeoutMs = opts.trustTimeoutMs ?? DEFAULT_TRUST_TIMEOUT_MS;
    this.onError = opts.onError ?? defaultError;
    this.runs = new RunRepository(opts.db);
    this.tasks = new TaskWorktreeRepository(opts.db);
  }

  /**
   * Resolves when the claim was confirmed (the task is in running and occupies its slot) and launches
   * the agent in the background; rejects with `DispatchError` if the claim does not go through.
   */
  async dispatch(decision: DispatchDecision): Promise<void> {
    const claim = claimRun(this.db, {
      decision,
      config: this.config,
      projects: this.projects,
      sessionId: this.newSessionId(),
    });
    if (!claim.ok) throw new DispatchError(claim.error.code, claim.error.message);
    this.background(claim.run.id);
  }

  /**
   * Resumes the claimed Runs that never got to send their prompt (after a crash). Skips those
   * already being launched: reconciliation (UW-17) calls it on each pass.
   */
  async recover(): Promise<void> {
    for (const run of this.runs.active()) {
      if (run.launchedAt === null && !this.launching.has(run.id)) this.background(run.id);
    }
  }

  /** Waits for launches in progress (for `stop` and for tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Launches the Run: idempotent. Each step is skipped if already done according to the Run and herdr. A failure
   * closes the Run as failure (`run_failed`) and closes its pane. If the Run is closed while
   * launching (cancellation during the bootstrap), the launch stops and closes what it opened.
   */
  launch(runId: string): Promise<RunRow> {
    return this.locks.run(runId, async () => {
      const run = this.runs.get(runId);
      if (!run) throw new DispatchError("run_not_found", `Run ${runId} does not exist`);
      if (run.endedAt !== null || run.launchedAt !== null) return run;
      try {
        return await this.launchSteps(run);
      } catch (error) {
        if (error instanceof RunClosed) {
          await this.release(run.id);
          return this.runs.get(run.id) ?? run;
        }
        try {
          await this.failRun(run.id, failureReason(error));
        } catch (failError) {
          // Do not mask the original error: both are reported and the pane is closed anyway.
          this.onError(asError(failError), run.id);
          await this.release(run.id).catch((e: unknown) => this.onError(asError(e), run.id));
        }
        throw error;
      }
    });
  }

  /**
   * Phase close: saves result, handoff and session identity and closes the pane. Called by
   * whoever applies the end-of-phase or cancellation transition (UW-15). Idempotent.
   */
  closeRun(runId: string, input: Omit<CloseRunInput, "session">) {
    return this.closeLocks.run(runId, async () => {
      const run = this.runs.get(runId);
      if (!run) throw new DispatchError("run_not_found", `Run ${runId} does not exist`);
      if (run.endedAt !== null) {
        // Another one closed it (the MCP exit tool): what remains is leaving its evidence and cleaning the pane.
        await this.releaseAndRecord(runId);
        return { closed: false, run };
      }
      const session = await this.resolveSession(run);
      const res = this.runs.close(runId, { ...input, ...(session && { session }) });
      await this.releaseAndRecord(runId);
      return res;
    });
  }

  /**
   * Cleans the pane of a Run that another closed: the LunasQ MCP exit tools close the Run
   * in their transaction and the dispatcher only stops the agent (ADR uw-15-mcp-tools). An open Run
   * is not touched.
   */
  releaseRun(runId: string): Promise<void> {
    return this.closeLocks.run(runId, async () => {
      if (this.runs.get(runId)?.endedAt == null) return;
      await this.releaseAndRecord(runId);
    });
  }

  /** Failed Run: closes it, applies `run_failed` if the task is still in its phase and closes the pane. */
  failRun(
    runId: string,
    reason: string,
    opts: { maxRetries?: number; providersUnavailable?: boolean } = {},
  ): Promise<FailRunResult> {
    return this.closeLocks.run(runId, async () => {
      if (!this.runs.get(runId))
        throw new DispatchError("run_not_found", `Run ${runId} does not exist`);
      const res = this.runs.fail(runId, reason, opts);
      // Also with closed false: a launch that fails after a close leaves its pane open.
      await this.releaseAndRecord(runId);
      return res;
    });
  }

  /** Paused dispatch: closes the Run without counting it as a failure and the task goes back to queued. */
  pauseRun(runId: string, reason: string): Promise<FailRunResult> {
    return this.closeLocks.run(runId, async () => {
      if (!this.runs.get(runId))
        throw new DispatchError("run_not_found", `Run ${runId} does not exist`);
      const res = this.runs.pause(runId, reason);
      await this.releaseAndRecord(runId);
      return res;
    });
  }

  /**
   * Closes the pane and then leaves the evidence: with the agent already stopped, its transcript is
   * complete (an MCP exit tool closes the Run while the agent finishes its turn). If
   * closing the pane fails, the evidence is written anyway.
   */
  private async releaseAndRecord(runId: string): Promise<void> {
    try {
      await this.release(runId);
    } finally {
      await this.recordEvidence(runId);
    }
  }

  /** Evidence is not part of the close: if it fails it is reported and the Run is closed anyway. */
  private async recordEvidence(runId: string): Promise<void> {
    try {
      await this.evidence?.recordRun(runId);
    } catch (error) {
      this.onError(asError(error), runId);
    }
  }

  private background(runId: string): void {
    this.launching.add(runId);
    const job = this.launch(runId).catch((error: unknown) => this.onError(asError(error), runId));
    this.inFlight.add(job);
    void job.finally(() => {
      this.inFlight.delete(job);
      this.launching.delete(runId);
    });
  }

  /** Throws RunClosed if the Run was closed while launching. */
  private checkOpen(runId: string): RunRow {
    const run = this.runs.get(runId);
    if (!run || run.endedAt !== null) throw new RunClosed();
    return run;
  }

  private async launchSteps(initial: RunRow): Promise<RunRow> {
    const phase = SchedulablePhaseSchema.parse(initial.phase);
    const name = requireName(initial);
    const { task, project } = this.taskAndProject(initial.taskId);
    const worktree = await this.worktrees.ensure(initial.taskId);
    let run = this.checkOpen(initial.id);

    let agent = await this.herdr.getAgent(name);
    if (agent && !this.owns(run, agent)) {
      throw new DispatchError(
        "agent_name_taken",
        `herdr agent ${name} belongs to another Run (pane ${agent.paneId})`,
      );
    }
    let fresh = !agent;
    if (!agent) {
      const started = await this.startAgentWithFallback(project, phase, run, name, worktree);
      if (!started) return this.runs.get(run.id) ?? run;
      agent = started;
      fresh = true;
      run = this.checkOpen(run.id);
    }
    // Just started and still loading (herdr returns `agent_not_ready` with the state of the
    // moment): wait for it to be ready or blocked before deciding.
    if (fresh && agent.status !== "idle" && agent.status !== "blocked") {
      agent = await this.herdr.waitAgent({
        name,
        until: ["idle", "blocked"],
        timeoutMs: this.startTimeoutMs,
      });
    } else if (!fresh && agent.status === "unknown") {
      agent = await this.herdr.waitAgent({
        name,
        until: ["idle", "blocked", "working", "done"],
        timeoutMs: this.startTimeoutMs,
      });
    }
    if (agent.status === "blocked") agent = await this.unblockStart(name, agent, fresh);
    run = this.checkOpen(run.id);

    const paneId = agent.paneId;
    if (run.herdrPane !== paneId || run.herdrWorkspace !== agent.workspaceId) {
      this.runs.recordPane(run.id, { workspaceId: agent.workspaceId, paneId });
    }
    await this.herdr.reportMetadata({
      paneId,
      title: `LunasQ ${phase} ${taskLabel(task.number)}`,
      tokens: { task: run.taskId, phase, iter: String(run.iteration), run: run.id },
    });
    run = this.checkOpen(run.id);
    // Only an idle agent has not received the prompt yet; working, blocked or done already have it.
    if (agent.status === "idle") {
      agent = await this.herdr.promptAgent({ name, text: phasePrompt(phase, run.taskId) });
    }
    const launched = this.runs.markLaunched(run.id);
    if (!launched) throw new DispatchError("run_not_found", `Run ${run.id} disappeared`);
    // A close that arrived during the prompt will no longer find the launch: it is closed here.
    this.checkOpen(run.id);
    this.observer?.watch(launched, agent);
    return launched;
  }

  private taskAndProject(taskId: string): { task: TaskWorktreeRecord; project: Project } {
    const task = this.tasks.get(taskId);
    const project = task ? this.projects.get(task.projectId) : null;
    if (!task || !project) {
      throw new DispatchError("project_not_found", `no project for ${taskId}`);
    }
    return { task, project };
  }

  /** The agent with the Run's name belongs to this Run: its metadata or its saved pane says so. */
  private owns(run: RunRow, agent: HerdrAgent): boolean {
    const owner = agent.tokens.run;
    if (owner !== undefined) return owner === run.id;
    return run.herdrPane !== null && agent.paneId === run.herdrPane;
  }

  private async startAgentWithFallback(
    project: Project,
    phase: SchedulablePhase,
    initial: RunRow,
    name: string,
    worktree: { workspaceId: string; rootPaneId: string; path: string },
  ): Promise<HerdrAgent | null> {
    const primary = phaseProfile(project, phase);
    // Only the providers enabled now; the human may have changed them after the claim, so
    // it is read again right before starting each one.
    const order = agentProviders.fallbackOrder(primary.kind);
    const isEnabled = (kind: AgentKind) => this.settings.providers()[kind];
    const attempts = this.runs.providerAttempts(initial.id);
    const latest = new Map<AgentKind, (typeof attempts)[number]["status"]>();
    for (const attempt of attempts) latest.set(attempt.provider, attempt.status);
    const diagnostics = attempts.flatMap((attempt) =>
      attempt.status === "failed" && attempt.reason
        ? [`${attempt.provider}: ${attempt.reason}`]
        : [],
    );

    if ([...latest.values()].includes("started")) {
      for (const [kind, status] of latest) {
        if (status !== "started") continue;
        const reason = "the process was interrupted before confirming the start";
        this.runs.recordProviderAttempt(initial.id, kind, "failed", reason);
        diagnostics.push(`${kind}: ${reason}`);
        latest.set(kind, "failed");
      }
      if (initial.herdrPane) {
        await this.herdr.closePane(initial.herdrPane);
        this.runs.clearPane(initial.id);
      }
    }

    const attempted = new Set(latest.keys());
    let saturated = false;
    for (const provider of order) {
      if (attempted.has(provider.kind) || !isEnabled(provider.kind)) continue;
      const switched = this.runs.switchAgentKind(
        initial.id,
        provider.kind,
        provider.kind === primary.kind ? (primary.model ?? null) : null,
        { projects: this.projects, config: this.config },
      );
      if (!switched) throw new DispatchError("run_not_found", `Run ${initial.id} does not exist`);
      if (switched === "no_slot") {
        // The claim reserved another provider: moving to this one would exceed its concurrency limit.
        diagnostics.push(`${provider.kind}: no concurrency slot`);
        saturated = true;
        continue;
      }
      let run: RunRow = switched;
      run = this.checkOpen(run.id);
      const args = await this.args(project, phase, run);
      const paneId = await this.ensurePane(run, worktree, phase);
      run = this.checkOpen(run.id);
      // Preparation waits for herdr and the file system: the human may have turned the provider off.
      if (!isEnabled(provider.kind)) {
        await this.herdr.closePane(paneId);
        this.runs.clearPane(run.id);
        await this.removeCopilotMcpConfig(run.id);
        continue;
      }
      this.runs.recordProviderAttempt(run.id, provider.kind, "started");
      try {
        const started = await this.herdr.startAgent({
          name,
          kind: provider.kind,
          paneId,
          args,
          timeoutMs: this.startTimeoutMs,
        });
        const agent = started.agent;
        if (agent.status !== "idle" && agent.status !== "blocked") {
          return await this.herdr.waitAgent({
            name,
            until: ["idle", "blocked"],
            timeoutMs: this.startTimeoutMs,
          });
        }
        return agent;
      } catch (error) {
        if (isHerdrError(error, "agent_name_taken")) throw error;
        const reason = asError(error).message.replaceAll(run.runToken, "[redacted]");
        diagnostics.push(`${provider.kind}: ${reason}`);
        this.runs.recordProviderAttempt(run.id, provider.kind, "failed", reason);
        await this.herdr.closePane(paneId);
        this.runs.clearPane(run.id);
      } finally {
        if (provider.kind === "copilot") await this.removeCopilotMcpConfig(run.id);
      }
    }

    if (order.every((p) => !isEnabled(p.kind))) {
      // The human turned them all off during the launch: it is not a CLI failure, the dispatch
      // pauses and the task waits in queued until one is enabled.
      await this.pauseRun(initial.id, "all providers are disabled in Settings");
      return null;
    }
    const hadRealFailure = this.runs
      .providerAttempts(initial.id)
      .some((a) => a.status === "failed");
    if (saturated && !hadRealFailure) {
      // No provider failed to start and an enabled one was left without a slot: it is transient
      // saturation, not a CLI failure. The task waits in queued and the scheduler
      // replans it when a slot frees up. If some provider did fail, the failure is counted
      // below: pausing would hide it and the scheduler would retry the broken provider without backoff.
      await this.pauseRun(initial.id, `no concurrency slot: ${diagnostics.join("; ")}`);
      return null;
    }
    const reason = `no provider responded on start: ${diagnostics.join("; ") || "no diagnosis"}`;
    await this.failRun(initial.id, reason, { providersUnavailable: true });
    return null;
  }

  private async args(project: Project, phase: SchedulablePhase, run: RunRow): Promise<string[]> {
    const profile = phaseProfile(project, phase);
    const selected = profile.kind === run.agentKind ? profile : { kind: run.agentKind, args: [] };
    try {
      const mcpConfigPath =
        selected.kind === "copilot" ? await this.writeCopilotMcpConfig(run) : this.mcpConfigPath;
      return agentProviders.get(selected.kind).args(selected, {
        mcpConfigPath,
        settingsPath: this.hookSettingsPath,
        sessionId: run.agentSession ?? run.id,
      });
    } catch (error) {
      if (error instanceof AgentProviderError || error instanceof DispatchRuleError) {
        throw new DispatchError("profile_conflict", error.message, { cause: error });
      }
      throw error;
    }
  }

  private async writeCopilotMcpConfig(run: RunRow): Promise<string> {
    if (!this.mcpUrl) {
      throw new DispatchError(
        "profile_conflict",
        "the LunasQ MCP URL is missing to configure Copilot CLI",
      );
    }
    const dir = await mkdtemp(join(tmpdir(), "lunasq-copilot-"));
    this.copilotMcpDirs.set(run.id, dir);
    const path = join(dir, "mcp.json");
    try {
      await writeFile(
        path,
        `${JSON.stringify({
          mcpServers: {
            lunasq: {
              type: "http",
              url: this.mcpUrl,
              headers: { "X-LunasQ-Run-Token": run.runToken },
            },
          },
        })}\n`,
        { mode: 0o600 },
      );
      await chmod(path, 0o600);
    } catch (error) {
      this.copilotMcpDirs.delete(run.id);
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return path;
  }

  private async removeCopilotMcpConfig(runId: string): Promise<void> {
    const dir = this.copilotMcpDirs.get(runId);
    if (!dir) return;
    this.copilotMcpDirs.delete(runId);
    await rm(dir, { recursive: true, force: true });
  }

  /**
   * The saved pane if it is still open, without an agent and in the task's worktree (herdr ids
   * are reused after a restart); otherwise a new one with the Run's environment.
   */
  private async ensurePane(
    run: RunRow,
    worktree: { workspaceId: string; rootPaneId: string; path: string },
    phase: SchedulablePhase,
  ): Promise<string> {
    if (run.herdrPane !== null) {
      const snap = await this.herdr.snapshot();
      const pane = snap.panes.find((p) => p.paneId === run.herdrPane);
      const busy = snap.agents.some((a) => a.paneId === run.herdrPane);
      if (
        pane &&
        !busy &&
        pane.workspaceId === worktree.workspaceId &&
        pane.cwd === worktree.path
      ) {
        return pane.paneId;
      }
    }
    const identity = { runToken: run.runToken, taskId: run.taskId, runId: run.id, phase };
    const env = {
      ...this.paneEnv,
      ...runEnv(identity),
    };
    if (run.agentKind === "copilot") {
      delete env.CLAUDE_CODE_ENABLE_TELEMETRY;
      delete env.OTEL_METRICS_EXPORTER;
      delete env.OTEL_LOGS_EXPORTER;
      delete env.OTEL_EXPORTER_OTLP_PROTOCOL;
      delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
      delete env.OTEL_LOG_TOOL_DETAILS;
      delete env.OTEL_RESOURCE_ATTRIBUTES;
      delete env.OTEL_EXPORTER_OTLP_HEADERS;
      delete env.CLAUDE_CODE_FORK_SUBAGENT;
      delete env.MCP_TOOL_TIMEOUT;
    } else {
      env.MCP_TOOL_TIMEOUT ??= String(DEFAULT_MCP_TOOL_TIMEOUT_MS);
      // The approver waits for the reviewers instead of launching them in the background.
      env.CLAUDE_CODE_FORK_SUBAGENT ??= "0";
    }
    const pane = await this.herdr.splitPane({
      paneId: worktree.rootPaneId,
      cwd: worktree.path,
      env: {
        ...env,
        ...(run.agentKind === "claude" && this.paneEnv.CLAUDE_CODE_ENABLE_TELEMETRY === "1"
          ? telemetryRunEnv(identity)
          : {}),
      },
    });
    this.runs.recordPane(run.id, { workspaceId: pane.workspaceId, paneId: pane.paneId });
    return pane.paneId;
  }

  /**
   * A new worktree opens Claude Code in the folder trust dialog (ADR 0004). It is accepted
   * only if the screen shows that dialog. Another `blocked` in a freshly started agent fails the
   * Run; in a reused one (crash after the prompt) it is a phase permission and is respected.
   */
  private async unblockStart(name: string, agent: HerdrAgent, fresh: boolean): Promise<HerdrAgent> {
    const screen = await this.herdr.readAgent({ name, lines: SCREEN_LINES });
    const acceptKeys =
      agent.kind === "copilot" && showsCopilotTrustDialog(screen)
        ? COPILOT_TRUST_ACCEPT_KEYS
        : showsTrustDialog(screen)
          ? TRUST_ACCEPT_KEYS
          : undefined;
    if (!acceptKeys) {
      if (!fresh) return agent;
      throw new DispatchError(
        "agent_blocked",
        `agent ${name} started blocked: ${screen.slice(-300)}`,
      );
    }
    await this.herdr.sendKeys({ name, keys: [...acceptKeys] });
    return this.herdr.waitAgent({ name, until: ["idle", "done"], timeoutMs: this.trustTimeoutMs });
  }

  private async resolveSession(run: RunRow) {
    if (run.agentSessionSource === "native") return undefined;
    const agent = run.herdrName
      ? await this.herdr.getAgent(run.herdrName).catch(() => undefined)
      : undefined;
    return resolveSession({ herdr: agent?.session, agentName: run.herdrName ?? run.id });
  }

  /**
   * Closes the Run's pane (and with it, its agent) and notifies the observer. Only if the pane is still
   * the Run's: it has its agent, or is empty in its workspace and in the task's worktree.
   */
  private async release(runId: string): Promise<void> {
    this.observer?.unwatch(runId);
    await this.removeCopilotMcpConfig(runId).catch((error: unknown) =>
      this.onError(asError(error), runId),
    );
    const run = this.runs.get(runId);
    if (!run?.herdrPane) return;
    const snap = await this.herdr.snapshot();
    const pane = snap.panes.find((p) => p.paneId === run.herdrPane);
    if (!pane) return;
    const agent = snap.agents.find((a) => a.paneId === pane.paneId);
    const ours = agent
      ? agent.name === run.herdrName
      : pane.workspaceId === run.herdrWorkspace &&
        pane.cwd === (this.tasks.get(run.taskId)?.worktreePath ?? null);
    if (ours) await this.herdr.closePane(pane.paneId);
  }
}

/** The Run was closed while launching: the launch stops without failing it. */
class RunClosed extends Error {}

function requireName(run: RunRow): string {
  if (!run.herdrName) throw new DispatchError("run_not_found", `Run ${run.id} has no name`);
  return run.herdrName;
}

/** Readable `failure_reason`: error code and its message. */
function failureReason(error: unknown): string {
  const err = asError(error);
  const code =
    isDispatchError(err) || isWorktreeError(err) || isHerdrError(err)
      ? (err as { code: string }).code
      : "launch_failed";
  return `${code}: ${err.message}`.slice(0, 2_000);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultError(error: Error, runId: string | null): void {
  console.error(`[dispatcher] fallo en ${runId ? `Run ${runId}` : "recover"}: ${error.message}`);
}
