// Delivery phase (docs/design.md §Delivery, ADR uw-26-entrega). It runs inside the verifier's
// Run, without an agent, once it recorded a pass: `before_delivery` hook, rebase onto the
// base, trailers on the commits, final suite, closing the Run and evidence file, push, PR with
// intent, criteria, evidence and risk label, `after_delivery` and `verdict_pass`. A conflict
// or a red suite send the task back to in_progress; any other failure escalates it. Each step
// can be repeated: a half-done delivery is resumed with `deliver` or `recover`.
import type { GitAdapter, GitHubAdapter } from "@lunasq/adapters";
import {
  appendEvent,
  applyTransition,
  type LunasqDatabase,
  listEvents,
  ProjectRepository,
  RunRepository,
  type RunRow,
  readVerificationSettings,
  SpecRepository,
  TaskPrRepository,
  TaskRepository,
  transitionTask,
} from "@lunasq/db";
import {
  commitTrailers,
  deliveryFacts,
  maxVerificationIterations,
  prBody,
  prTitle,
  riskPrLabel,
} from "@lunasq/domain";
import {
  DELIVERY_CONFLICT,
  DELIVERY_OUTPUT_LIMIT,
  type DeliveryConflictPayload,
  type DeliveryConflictReason,
  evidencePath,
  type Handoff,
  type Project,
  parseHandoff,
  type RunResult,
  TASK_TRANSITIONED,
} from "@lunasq/schemas";
import type { TestGate } from "../mcp/ports.ts";
import { type PhaseHooks, tailOf } from "../mcp/ports.ts";
import { KeyedLock } from "../worktrees/keyed-lock.ts";
import type { EnsuredWorktree } from "../worktrees/service.ts";

export type DeliveryResult =
  | { status: "delivered"; prUrl: string; created: boolean }
  /** The task went back to in_progress (or escalated, if there have been too many conflicts). */
  | { status: "conflict"; reason: DeliveryConflictReason }
  /** A hook with block policy stopped the delivery; HookService already escalated the task. */
  | { status: "blocked" }
  | { status: "escalated"; error: string }
  | {
      status: "skipped";
      reason: "task_not_found" | "not_delivering" | "no_pass_verdict" | "no_spec";
    };

export interface DeliveryServiceDeps {
  db: LunasqDatabase;
  git: Pick<
    GitAdapter,
    "fetch" | "rebase" | "listCommits" | "addTrailers" | "push" | "resolveCommit"
  >;
  github: Pick<GitHubAdapter, "createPr" | "addLabels">;
  hooks: PhaseHooks;
  testGate: TestGate;
  /** WorktreeService.ensure: the delivery runs in the task's worktree. */
  worktrees: { ensure(taskId: string): Promise<EnsuredWorktree> };
  /** PhaseDispatcher: closes the Run, its pane and leaves the evidence section. */
  runs: {
    closeRun(runId: string, input: { result: RunResult; failureReason?: string }): Promise<unknown>;
  };
  /** EvidenceService: without it, the evidence file does not travel in the PR. */
  evidence?: { commit(taskId: string): Promise<string | null> };
  remote?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Maximum length of an escalation's note (TaskTransitionedPayload.note). */
const NOTE_LIMIT = 2000;

/** Delivery stop that is not an error: it is returned as is. */
class Stop extends Error {
  readonly result: DeliveryResult;

  constructor(result: DeliveryResult) {
    super(result.status);
    this.result = result;
  }
}

export class DeliveryService {
  readonly #deps: DeliveryServiceDeps;
  readonly #tasks: TaskRepository;
  readonly #projects: ProjectRepository;
  readonly #runs: RunRepository;
  readonly #specs: SpecRepository;
  readonly #prs: TaskPrRepository;
  readonly #remote: string;
  /** One delivery at a time per task: the outbox delivers at least once. */
  readonly #locks = new KeyedLock();

  constructor(deps: DeliveryServiceDeps) {
    this.#deps = deps;
    this.#tasks = new TaskRepository(deps.db);
    this.#projects = new ProjectRepository(deps.db);
    this.#runs = new RunRepository(deps.db);
    this.#specs = new SpecRepository(deps.db);
    this.#prs = new TaskPrRepository(deps.db);
    this.#remote = deps.remote ?? "origin";
  }

  /** Delivers the task whose verifier gave a pass. Idempotent. */
  deliver(taskId: string): Promise<DeliveryResult> {
    return this.#locks.run(taskId, () => this.#deliver(taskId));
  }

  /**
   * Resumes the deliveries a restart left half done: tasks in verification/running with a saved
   * pass. A verification in progress (without a pass) is not touched.
   */
  async recover(): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];
    for (const task of this.#tasks.list({ state: "verification" })) {
      if (task.subState !== "running") continue;
      const result = await this.deliver(task.id);
      if (result.status !== "skipped") results.push(result);
    }
    return results;
  }

  async #deliver(taskId: string): Promise<DeliveryResult> {
    const task = this.#tasks.get(taskId);
    if (!task) return { status: "skipped", reason: "task_not_found" };
    if (task.state !== "verification" || task.subState !== "running") {
      return { status: "skipped", reason: "not_delivering" };
    }
    const latest = this.#runs.latestHandoff(taskId, "verify");
    const parsed = latest ? parseHandoff(latest.handoff) : null;
    if (!latest || !parsed?.success || parsed.data.phase !== "verification") {
      return { status: "skipped", reason: "no_pass_verdict" };
    }
    const verification = parsed.data;
    if (verification.body.verdict !== "pass") {
      return { status: "skipped", reason: "no_pass_verdict" };
    }
    const run = this.#runs.get(latest.runId);
    const spec = this.#specs.approved(taskId);
    const project = this.#projects.get(task.projectId);
    if (!run || !project) return { status: "skipped", reason: "task_not_found" };
    if (!spec) return { status: "skipped", reason: "no_spec" };

    try {
      return await this.#run({
        taskId,
        intent: task.intent,
        title: task.title,
        run,
        project,
        spec,
        verification,
      });
    } catch (error) {
      if (error instanceof Stop) return error.result;
      return this.#escalate(taskId, run, "delivery_failed", message(error));
    }
  }

  async #run(ctx: {
    taskId: string;
    intent: string;
    title: string | null;
    run: RunRow;
    project: Project;
    spec: NonNullable<ReturnType<SpecRepository["approved"]>>;
    verification: Extract<Handoff, { phase: "verification" }>;
  }): Promise<DeliveryResult> {
    const { taskId, run, project } = ctx;
    const { git, github, testGate } = this.#deps;
    const base = project.baseBranch;
    const worktree = await this.#deps.worktrees.ensure(taskId);

    await this.#hook(taskId, run, "before_delivery");

    // Closes of earlier Runs (e.g. implementation's) leave new sections in the
    // evidence file. If the project tracks it, those edits dirty the worktree and the
    // rebase fails with «You have unstaged changes»: they are committed before integrating the base. The
    // delivery calls it again after closing the verifier's Run, so its section also
    // travels in the PR.
    await this.#deps.evidence?.commit(taskId);

    // Integrating the base: a conflict is not resolved here, the implementer resolves it.
    await git.fetch({ cwd: worktree.path, remote: this.#remote, branch: base });
    const onto = `${this.#remote}/${base}`;
    const rebase = await git.rebase({ cwd: worktree.path, onto });
    if (rebase.status === "conflict") {
      return this.#conflict(ctx, { reason: "rebase_conflict", files: rebase.files, output: null });
    }

    // LunasQ-Task and LunasQ-Run trailers on each branch commit.
    const commits = await git.listCommits({ cwd: worktree.path, base: onto });
    await git.addTrailers({
      cwd: worktree.path,
      base: onto,
      trailers: commitTrailers({
        taskId,
        commits,
        runs: this.#runs.forTask(taskId),
        fallbackRunId: run.id,
      }),
    });

    // Final suite on what is going to be published.
    const gate = await testGate.run({
      taskId,
      runId: run.id,
      worktreePath: worktree.path,
      command: project.testCommand,
      trigger: "delivery",
    });
    if (!gate.passed) {
      return this.#conflict(ctx, {
        reason: "tests_failed",
        files: [],
        output: tailOf(gate.output, DELIVERY_OUTPUT_LIMIT),
      });
    }

    // The Run is closed before the push so its evidence section travels in the PR.
    await this.#closeRun(run, "success");
    await this.#deps.evidence?.commit(taskId);

    await git.push({ cwd: worktree.path, remote: this.#remote, branch: worktree.branch });

    const { pr, created } = await github.createPr({
      cwd: worktree.path,
      head: worktree.branch,
      base,
      title: prTitle(ctx.intent, ctx.title),
      body: prBody({
        taskId,
        runId: run.id,
        intent: ctx.intent,
        specVersion: ctx.spec.version,
        criteria: ctx.spec.content.criteria,
        verification: ctx.verification.body,
        evidencePath: evidencePath(taskId),
        baseBranch: base,
      }),
    });
    // The label is for prioritizing review: if it fails, the PR is still valid.
    await github
      .addLabels({
        cwd: worktree.path,
        url: pr.url,
        labels: [riskPrLabel(ctx.verification.body.riskLabel)],
      })
      .catch(() => undefined);
    // Repeating the registration of the same open PR writes nothing; another open PR throws TaskPrError.
    this.#prs.recordPrOpened(taskId, pr.url);

    // A hook that commits (HookService includes its changes in a commit) leaves HEAD ahead of
    // what was published: a second push carries them to the PR.
    const published = await git.resolveCommit({ cwd: worktree.path, ref: "HEAD" });
    await this.#hook(taskId, run, "after_delivery", pr.url);
    if ((await git.resolveCommit({ cwd: worktree.path, ref: "HEAD" })) !== published) {
      await git.push({ cwd: worktree.path, remote: this.#remote, branch: worktree.branch });
    }

    const facts = deliveryFacts({
      criteria: ctx.spec.content.criteria,
      implementation: this.#implementation(taskId),
      verification: ctx.verification.body,
    });
    const passed = transitionTask(this.#deps.db, {
      taskId,
      actor: "system",
      command: { type: "verdict_pass", ...facts, testGatePassed: true, prCreated: true },
      expected: { state: "verification", subState: "running" },
    });
    if (!passed.ok) {
      throw new Error(`verdict_pass rejected: ${passed.error.code}: ${passed.error.message}`);
    }
    return { status: "delivered", prUrl: pr.url, created };
  }

  /** Last saved implementation handoff, to check that each criterion has tests. */
  #implementation(taskId: string) {
    for (const stored of this.#runs.handoffs(taskId, "implement").reverse()) {
      const parsed = parseHandoff(stored);
      if (parsed.success && parsed.data.phase === "implementation") return parsed.data.body;
    }
    return null;
  }

  async #hook(
    taskId: string,
    run: RunRow,
    point: "before_delivery" | "after_delivery",
    prUrl?: string,
  ) {
    const result = await this.#deps.hooks.run({
      taskId,
      point,
      runId: run.id,
      ...(prUrl !== undefined && { prUrl }),
    });
    if (result.outcome !== "blocked") return;
    if (!result.escalated) {
      this.#escalateTask(taskId, "hook_failed", result.error ?? `point ${point} blocked`);
    }
    throw new Stop({ status: "blocked" });
  }

  /**
   * Integration conflict or red suite: the task goes back to in_progress without raising the
   * iteration and the implementer receives what caused it. With as many conflicts as iterations
   * the project allows, it escalates instead of repeating the cycle.
   */
  async #conflict(
    ctx: { taskId: string; run: RunRow; project: Project },
    detail: { reason: DeliveryConflictReason; files: string[]; output: string | null },
  ): Promise<DeliveryResult> {
    const { taskId, run, project } = ctx;
    const previous = this.#conflicts(taskId);
    const cap = maxVerificationIterations(
      project,
      readVerificationSettings(this.#deps.db).maxVerificationIterations,
    );
    if (previous >= cap) {
      return this.#escalate(
        taskId,
        run,
        "delivery_failed",
        `${previous} consecutive deliveries went back to implementation (${detail.reason})`,
      );
    }
    await this.#closeRun(run, "success");
    // Its evidence section was just written: committing it leaves the worktree clean so
    // the implementer can integrate the base without a `git rebase` failing from
    // uncommitted changes in the tracked file.
    await this.#deps.evidence?.commit(taskId).catch(() => undefined);
    const payload: DeliveryConflictPayload = {
      runId: run.id,
      reason: detail.reason,
      baseBranch: project.baseBranch,
      files: detail.files,
      output: detail.output,
    };
    this.#deps.db.transaction(
      (tx) => {
        const moved = applyTransition(tx, {
          taskId,
          actor: "system",
          command: { type: "delivery_conflict" },
          expected: { state: "verification", subState: "running" },
        });
        if (!moved.ok) throw new Error(`delivery_conflict rejected: ${moved.error.message}`);
        appendEvent(
          tx,
          { taskId, type: DELIVERY_CONFLICT, actor: "system", payload },
          { publish: true },
        );
      },
      { behavior: "immediate" },
    );
    return { status: "conflict", reason: detail.reason };
  }

  /**
   * Delivery conflicts in a row: since the last `resume` (a human resuming grants another
   * round) or the last `verdict_pass` (a delivered PR that later ends up in conflict starts from
   * zero, ADR pr-en-conflicto).
   */
  #conflicts(taskId: string): number {
    let count = 0;
    for (const event of listEvents(this.#deps.db, taskId)) {
      if (event.type === DELIVERY_CONFLICT) count += 1;
      else if (event.type === TASK_TRANSITIONED) {
        const payload = event.payload as { command?: string };
        if (payload.command === "resume" || payload.command === "verdict_pass") count = 0;
      }
    }
    return count;
  }

  async #escalate(
    taskId: string,
    run: RunRow,
    reason: "delivery_failed",
    note: string,
  ): Promise<DeliveryResult> {
    // The Run is not left open with the task in needs_human; "cancelled" does not count as a failure.
    if (!this.#runs.get(run.id)?.endedAt) {
      await this.#closeRun(run, "cancelled", `delivery_failed: ${note}`).catch(() => undefined);
      await this.#deps.evidence?.commit(taskId).catch(() => undefined);
    }
    this.#escalateTask(taskId, reason, note);
    return { status: "escalated", error: note };
  }

  #escalateTask(taskId: string, reason: "delivery_failed" | "hook_failed", note: string) {
    transitionTask(this.#deps.db, {
      taskId,
      actor: "system",
      command: { type: "escalate", reason, note: note.slice(0, NOTE_LIMIT) },
      expected: { state: "verification", subState: "running" },
    });
  }

  async #closeRun(run: RunRow, result: RunResult, failureReason?: string) {
    // A Run already closed (resumed delivery) is not closed again.
    if (this.#runs.get(run.id)?.endedAt) return;
    await this.#deps.runs.closeRun(run.id, {
      result,
      ...(failureReason && { failureReason }),
    });
  }
}
