// Per-phase hooks (UW-10; docs/design.md §Per-phase hooks, ADR uw-10-hooks). LunasQ reads the scripts
// and lunasq/hooks/config from the `origin/<base>` commit, never from the worktree or the task's
// branch, copies them outside the worktree and runs them in order in a herdr pane. Each run
// and the point's result are left in the Event log; a failure with the block policy sends the task to
// needs_human. Connecting each point to its phase is up to whoever orchestrates it (UW-16, UW-23, UW-26).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GitAdapter,
  type HerdrAdapter,
  HerdrPaneRunner,
  type ProcessResult,
  type ProcessRunner,
} from "@lunasq/adapters";
import { appendEvent, type LunasqDatabase, transitionTask } from "@lunasq/db";
import {
  HOOKS_CONFIG_PATH,
  HOOKS_DIR,
  hookPointEscalates,
  hookPointOutcome,
  hookPointPhase,
  hookPointRunsInWorktree,
  hookStopsPoint,
  type PlannedHook,
  type ProjectConfigReader,
  parseHooksConfig,
  planHooks,
  type TaskWorktreeStore,
} from "@lunasq/domain";
import {
  COMMIT_TRAILER_RUN,
  COMMIT_TRAILER_TASK,
  HOOK_EXECUTED,
  HOOK_OUTPUT_LIMIT,
  HOOK_POINT_COMPLETED,
  HookExecutedPayload,
  type HookPoint,
  HookPointCompletedPayload,
  HookPoint as HookPointEnum,
  type HookPointOutcome,
  type Project,
} from "@lunasq/schemas";
import { KeyedLock } from "../worktrees/keyed-lock.ts";
import type { EnsuredWorktree } from "../worktrees/service.ts";

export type HookErrorCode = "task_not_found" | "project_not_found";

export class HookError extends Error {
  readonly code: HookErrorCode;

  constructor(code: HookErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HookError";
    this.code = code;
  }
}

export function isHookError(err: unknown, code?: HookErrorCode): err is HookError {
  return err instanceof HookError && (code === undefined || err.code === code);
}

export interface HookServiceDeps {
  db: LunasqDatabase;
  git: GitAdapter;
  herdr: HerdrAdapter;
  projects: ProjectConfigReader;
  tasks: TaskWorktreeStore;
  /** Ensures the task's worktree (WorktreeService.ensure); the hooks run there. */
  worktrees: { ensure(taskId: string): Promise<EnsuredWorktree> };
  /** Runner that opens a pane from `parentPaneId`; HerdrPaneRunner by default. */
  runnerFor?: (parentPaneId: string) => ProcessRunner;
  /** Where each run's private directory is created; the tmpdir by default. */
  scriptsDir?: string;
}

export interface RunHooksInput {
  taskId: string;
  point: HookPoint;
  /** The phase's Run; there is none in after_merge. */
  runId?: string | null;
  prUrl?: string | null;
  /** Result of the phase that ends (e.g. the verdict), for the `after_*` and `on_failure` hooks. */
  phaseResult?: string | null;
}

export interface HookExecution extends PlannedHook {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  passed: boolean;
  output: string;
}

export interface HookPointResult {
  point: HookPoint;
  /** Commit of the base branch the hooks were read from; null if it could not be read. */
  baseRef: string | null;
  outcome: HookPointOutcome;
  executions: HookExecution[];
  failedScript: string | null;
  error: string | null;
  commit: string | null;
  commitSkipped: boolean;
  /** The task moved to needs_human with `hook_failed`. */
  escalated: boolean;
}

export interface ProjectHooks {
  baseRef: string;
  /** Error in lunasq/hooks/config; with it, the settings shown are the defaults. */
  configError: string | null;
  points: { point: HookPoint; hooks: (PlannedHook & { content: string })[] }[];
}

/** Single quote for sh. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const pointDir = (point: HookPoint) => `${HOOKS_DIR}/${point}`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Location {
  cwd: string;
  paneId: string;
  branch: string;
  /** The changes the hooks leave are committed (only in the task's worktree). */
  commits: boolean;
}

interface Prepared {
  where: Location;
  dir: string;
  dirtyBefore: boolean;
  cleanup(): Promise<void>;
}

/** Hooks read from a commit of the base branch. */
interface BaseHooks {
  baseRef: string;
  files: { name: string; executable: boolean }[];
}

export class HookService {
  private readonly db: LunasqDatabase;
  private readonly git: GitAdapter;
  private readonly herdr: HerdrAdapter;
  private readonly projects: ProjectConfigReader;
  private readonly tasks: TaskWorktreeStore;
  private readonly worktrees: HookServiceDeps["worktrees"];
  private readonly runnerFor: (parentPaneId: string) => ProcessRunner;
  private readonly scriptsDir: string;
  /** A task's points do not overlap. */
  private readonly locks = new KeyedLock();
  /** One fetch at a time per project checkout: git locks the refs. */
  private readonly fetchLocks = new KeyedLock();

  constructor(deps: HookServiceDeps) {
    this.db = deps.db;
    this.git = deps.git;
    this.herdr = deps.herdr;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.worktrees = deps.worktrees;
    this.runnerFor =
      deps.runnerFor ??
      ((parentPaneId) => new HerdrPaneRunner({ herdr: deps.herdr, parentPaneId }));
    this.scriptsDir = deps.scriptsDir ?? tmpdir();
  }

  /**
   * Runs the hooks of `point` for the task, in order, and returns the point's result. A
   * script with the block policy that fails stops the following ones and, except in after_merge and
   * on_failure, sends the task to needs_human. Any failure reading the base or preparing the
   * run (e.g. the worktree) blocks the point and is recorded. Throws only if the task or
   * the project does not exist.
   */
  run(input: RunHooksInput): Promise<HookPointResult> {
    return this.locks.run(input.taskId, () => this.runLocked(input));
  }

  /** Hooks of each point as they are in the base branch, for the front end view (UW-25). */
  async listHooks(projectId: string): Promise<ProjectHooks> {
    const project = this.project(projectId);
    const baseRef = await this.fetchBase(project);
    const config = parseHooksConfig(await this.readText(project, baseRef, HOOKS_CONFIG_PATH));
    const points = [];
    for (const point of HookPointEnum.options) {
      const { files } = await this.readPoint(project, baseRef, point);
      const planned = planHooks(
        point,
        files.filter((f) => f.executable).map((f) => f.name),
        config.ok ? config.config : {},
      );
      const hooks = [];
      for (const hook of planned) {
        const content = await this.readText(project, baseRef, `${pointDir(point)}/${hook.script}`);
        hooks.push({ ...hook, content: content ?? "" });
      }
      points.push({ point, hooks });
    }
    return { baseRef, configError: config.ok ? null : config.message, points };
  }

  private async runLocked(input: RunHooksInput): Promise<HookPointResult> {
    const task = this.tasks.get(input.taskId);
    if (!task) throw new HookError("task_not_found", `task ${input.taskId} does not exist`);
    const project = this.project(task.projectId);
    const { point } = input;
    const runId = input.runId ?? null;

    let base: BaseHooks;
    let plan: PlannedHook[];
    try {
      const baseRef = await this.fetchBase(project);
      base = { baseRef, ...(await this.readPoint(project, baseRef, point)) };
      const scripts = base.files.filter((f) => f.executable).map((f) => f.name);
      // With no scripts at the point nothing is recorded: it is the case for almost all points.
      if (scripts.length === 0) return emptyResult(point, baseRef);
      const config = parseHooksConfig(await this.readText(project, baseRef, HOOKS_CONFIG_PATH));
      if (!config.ok) {
        return this.finish(input, { ...emptyResult(point, baseRef), error: config.message });
      }
      plan = planHooks(point, scripts, config.config);
    } catch (err) {
      const error = `could not read the hooks from origin/${project.baseBranch}: ${message(err)}`;
      return this.finish(input, { ...emptyResult(point, null), error });
    }

    let prepared: Prepared;
    try {
      prepared = await this.prepare(project, input, base);
    } catch (err) {
      const error = `could not prepare the hooks: ${message(err)}`;
      return this.finish(input, { ...emptyResult(point, base.baseRef), error });
    }

    try {
      const { where, dir, dirtyBefore } = prepared;
      const env = this.env(project, input, where);
      const runner = this.runnerFor(where.paneId);

      const executions: HookExecution[] = [];
      for (const hook of plan) {
        const execution = await this.execute(runner, hook, join(dir, hook.script), where.cwd, env);
        executions.push(execution);
        appendEvent(
          this.db,
          {
            taskId: input.taskId,
            type: HOOK_EXECUTED,
            actor: "system",
            payload: HookExecutedPayload.parse({
              point,
              script: hook.script,
              baseRef: base.baseRef,
              runId,
              policy: hook.policy,
              timeoutSeconds: hook.timeoutSeconds,
              exitCode: execution.exitCode,
              timedOut: execution.timedOut,
              durationMs: execution.durationMs,
              passed: execution.passed,
              output: execution.output,
            }),
          },
          { publish: true },
        );
        if (hookStopsPoint(execution)) break;
      }

      const result: HookPointResult = {
        ...emptyResult(point, base.baseRef),
        outcome: hookPointOutcome(executions),
        executions,
        failedScript: executions.find(hookStopsPoint)?.script ?? null,
      };
      if (where.commits && result.outcome !== "blocked") {
        await this.commitChanges(input, where.cwd, dirtyBefore, result);
      }
      return this.finish(input, result);
    } finally {
      await prepared.cleanup();
    }
  }

  /**
   * Private directory of the run (mkdtemp, 0700) with the point's files copied from the
   * base branch, and the place where they run: the task's worktree or, for after_merge, a
   * temporary checkout at detached HEAD on the base commit, deleted when done.
   */
  private async prepare(
    project: Project,
    input: RunHooksInput,
    base: BaseHooks,
  ): Promise<Prepared> {
    await mkdir(this.scriptsDir, { recursive: true, mode: 0o700 });
    const runDir = await mkdtemp(join(this.scriptsDir, "lunasq-hooks-"));
    let checkout: string | undefined;
    const cleanup = async () => {
      if (checkout) await this.git.removeWorktree({ cwd: project.localPath, path: checkout });
      await rm(runDir, { recursive: true, force: true });
    };
    try {
      const dir = await this.materialize(project, base, input.point, join(runDir, "hooks"));
      let where: Location;
      if (hookPointRunsInWorktree(input.point)) {
        const worktree = await this.worktrees.ensure(input.taskId);
        where = {
          cwd: worktree.path,
          paneId: worktree.rootPaneId,
          branch: worktree.branch,
          commits: true,
        };
      } else {
        checkout = join(runDir, "checkout");
        await this.git.addDetachedWorktree({
          cwd: project.localPath,
          path: checkout,
          commit: base.baseRef,
        });
        const { rootPaneId } = await this.herdr.ensureWorkspace({
          cwd: project.localPath,
          label: project.name,
        });
        where = { cwd: checkout, paneId: rootPaneId, branch: project.baseBranch, commits: false };
      }
      const dirtyBefore = where.commits && (await this.git.isDirty(where.cwd));
      return { where, dir, dirtyBefore, cleanup };
    } catch (err) {
      await cleanup().catch(() => {});
      throw err;
    }
  }

  private fetchBase(project: Project): Promise<string> {
    return this.fetchLocks.run(project.localPath, async () => {
      // The sha fetch returns comes from the remote: `origin/<base>` is not re-read, since it lives in the
      // shared gitdir and a task's worktree could move it.
      return this.git.fetch({
        cwd: project.localPath,
        remote: "origin",
        branch: project.baseBranch,
      });
    });
  }

  private async readPoint(project: Project, baseRef: string, point: HookPoint) {
    const files = await this.git.listFiles({
      cwd: project.localPath,
      commit: baseRef,
      dir: pointDir(point),
    });
    return { files };
  }

  private async readText(project: Project, baseRef: string, path: string) {
    const content = await this.git.readFile({ cwd: project.localPath, commit: baseRef, path });
    return content?.toString("utf8");
  }

  /** Copies the point's files (scripts and auxiliaries) from the base commit to `dir`. */
  private async materialize(project: Project, base: BaseHooks, point: HookPoint, dir: string) {
    await mkdir(dir, { mode: 0o700 });
    for (const file of base.files) {
      const content = await this.git.readFile({
        cwd: project.localPath,
        commit: base.baseRef,
        path: `${pointDir(point)}/${file.name}`,
      });
      if (!content) continue;
      await writeFile(join(dir, file.name), content, {
        mode: file.executable ? 0o700 : 0o600,
        flag: "wx",
      });
    }
    return dir;
  }

  private env(project: Project, input: RunHooksInput, where: { cwd: string; branch: string }) {
    const phase = hookPointPhase(input.point);
    return {
      LUNASQ_PROJECT_ID: project.id,
      LUNASQ_TASK_ID: input.taskId,
      LUNASQ_HOOK_POINT: input.point,
      LUNASQ_WORKTREE: where.cwd,
      LUNASQ_BRANCH: where.branch,
      LUNASQ_BASE_BRANCH: project.baseBranch,
      ...(input.runId && { LUNASQ_RUN_ID: input.runId }),
      ...(phase && { LUNASQ_PHASE: phase }),
      ...(input.prUrl && { LUNASQ_PR_URL: input.prUrl }),
      ...(input.phaseResult && { LUNASQ_PHASE_RESULT: input.phaseResult }),
    };
  }

  private async execute(
    runner: ProcessRunner,
    hook: PlannedHook,
    path: string,
    cwd: string,
    env: Record<string, string>,
  ): Promise<HookExecution> {
    const started = Date.now();
    let res: ProcessResult;
    try {
      res = await runner.run({
        command: shellQuote(path),
        cwd,
        env,
        timeoutMs: hook.timeoutSeconds * 1_000,
      });
    } catch (err) {
      // It could not even be launched (e.g. herdr down): counts as a hook failure.
      res = {
        exitCode: 1,
        stdout: "",
        stderr: `could not run: ${message(err)}`,
        timedOut: false,
      };
    }
    const output = `${res.stdout}${res.stderr}`.slice(-HOOK_OUTPUT_LIMIT);
    return {
      ...hook,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      durationMs: Date.now() - started,
      passed: res.exitCode === 0 && !res.timedOut,
      output,
    };
  }

  /**
   * Commits what the hooks left, with the task's trailers. If the worktree already had
   * uncommitted changes before the hooks it does not commit: it would mix in the agent's changes.
   */
  private async commitChanges(
    input: RunHooksInput,
    cwd: string,
    dirtyBefore: boolean,
    result: HookPointResult,
  ) {
    try {
      if (!(await this.git.isDirty(cwd))) return;
      if (dirtyBefore) {
        // What the hooks left stays uncommitted: whoever follows (e.g. the push) must know.
        result.commitSkipped = true;
        result.outcome = "warned";
        return;
      }
      result.commit = await this.git.commitAll({
        cwd,
        message: `chore(lunasq): hooks ${input.point}`,
        trailers: {
          [COMMIT_TRAILER_TASK]: input.taskId,
          ...(input.runId && { [COMMIT_TRAILER_RUN]: input.runId }),
        },
      });
    } catch (err) {
      result.outcome = "blocked";
      result.error = `could not commit what the hooks left: ${message(err)}`;
    }
  }

  /** Records the point's result and, if it blocks, escalates the task. */
  private finish(input: RunHooksInput, result: HookPointResult): HookPointResult {
    const blocked = result.error !== null || result.outcome === "blocked";
    const final = { ...result, outcome: blocked ? ("blocked" as const) : result.outcome };
    appendEvent(
      this.db,
      {
        taskId: input.taskId,
        type: HOOK_POINT_COMPLETED,
        actor: "system",
        payload: HookPointCompletedPayload.parse({
          point: final.point,
          baseRef: final.baseRef,
          runId: input.runId ?? null,
          outcome: final.outcome,
          failedScript: final.failedScript,
          error: final.error?.slice(0, 2000) ?? null,
          commit: final.commit,
          commitSkipped: final.commitSkipped,
        }),
      },
      { publish: true },
    );
    if (blocked && hookPointEscalates(final.point)) {
      const note = final.failedScript
        ? `hook ${final.point}/${final.failedScript} failed`
        : `hooks de ${final.point}: ${final.error ?? "fallo"}`;
      const res = transitionTask(this.db, {
        taskId: input.taskId,
        actor: "system",
        command: { type: "escalate", reason: "hook_failed", note: note.slice(0, 2000) },
      });
      // If the task can no longer escalate (e.g. it is already in needs_human) the failure stays recorded.
      final.escalated = res.ok;
    }
    return final;
  }

  private project(projectId: string): Project {
    const project = this.projects.get(projectId);
    if (!project) throw new HookError("project_not_found", `project ${projectId} does not exist`);
    return project;
  }
}

function emptyResult(point: HookPoint, baseRef: string | null): HookPointResult {
  return {
    point,
    baseRef,
    outcome: "passed",
    executions: [],
    failedScript: null,
    error: null,
    commit: null,
    commitSkipped: false,
    escalated: false,
  };
}
