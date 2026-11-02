// Logic of the LunasQ MCP tools, without transport (docs/design.md §MCPs and skills, ADR
// uw-15-mcp-tools). Each call goes through the same order of guards: run token of an active Run,
// tool allowed in the Run's phase and get_task_context already read. The exit tools write the
// handoff, the Run close and the task transition in a single IMMEDIATE transaction. The
// verification phase (ADR uw-23-verificacion) adds the phase hooks, the reviewers'
// evidence, the project's iteration cap and the risk label.

import { randomUUID } from "node:crypto";
import {
  appendChecklist,
  applyTaskTitle,
  applyTransition,
  closeRun,
  completeTaskWithResult,
  consecutiveFailures,
  createQuestion,
  type LunasqDatabase,
  latestChecklist,
  listEvents,
  listQuestions,
  ProjectRepository,
  RunRepository,
  type RunRow,
  RunSubagentRepository,
  recordVerdict,
  SpecRepository,
  TaskRepository,
  type TransitionTaskInput,
  type Tx,
} from "@lunasq/db";
import { checkReviewerEvidence, maxVerificationIterations } from "@lunasq/domain";
import {
  type AskHumanInput,
  type ChecklistItem,
  DELIVERY_CONFLICT,
  DeliveryConflictPayload,
  type Handoff,
  type HandoffError,
  type HandoffPhase,
  type HookPoint,
  type MustFixFinding,
  type Phase,
  parseHandoff,
  parseResultHandoff,
  REVIEWER_NAMES,
  type ReportFailureInput,
  type RunReviewerInput,
  type Spec,
  type TaskContext,
  TEST_GATE_EXECUTED,
  TestGateExecutedPayload,
  type TestGateTrigger,
  type UpdateChecklistInput,
  VERDICT_RECORDED,
} from "@lunasq/schemas";
import type { CopilotReviewerExecutor } from "./copilot-reviewer.ts";
import type { CommitVerifier, PhaseHooks, TestGate } from "./ports.ts";

export const TOOL_NAMES = [
  "get_task_context",
  "submit_spec",
  "ask_human",
  "update_checklist",
  "submit_for_verification",
  "submit_result",
  "run_reviewer",
  "submit_verdict",
  "report_failure",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const ALL_PHASES: readonly Phase[] = ["refine", "implement", "verify", "deliver"];

/**
 * Rejections of the pass the implementer can fix (dirty worktree, moved HEAD). Instead of
 * leaving the verifier with no way out, the pass becomes a reject with a must-fix that sends the
 * task back to implementation, where the agent commits, ignores or rebuilds its HEAD.
 */
const GIT_REWORK_CODES: ReadonlySet<McpErrorCode> = new Set(["dirty_worktree", "head_changed"]);

/** Reject with a git must-fix that replaces a pass refused because of the worktree state. */
function gitReworkHandoff(handoff: VerificationHandoff, error: McpError): VerificationHandoff {
  const paths = (error.issues ?? []).map((issue) => issue.path);
  const finding: MustFixFinding = {
    severity: "major",
    file: paths[0] ?? ".",
    evidence: [
      `LunasQ did not accept the pass: ${error.message}.`,
      ...(paths.length > 0 ? [`Files: ${paths.join(", ")}.`] : []),
      "Fix the git state: commit whatever is part of the change, ignore what tools generate and do not touch files that are not yours. Then call submit_for_verification again.",
    ].join(" "),
    source: "approver",
  };
  return { ...handoff, body: { ...handoff.body, verdict: "reject", mustFix: [finding] } };
}

/** Phases of the Run in which each tool is accepted. */
export const TOOL_PHASES: Readonly<Record<ToolName, readonly Phase[]>> = {
  get_task_context: ALL_PHASES,
  ask_human: ALL_PHASES,
  report_failure: ALL_PHASES,
  submit_spec: ["refine"],
  update_checklist: ["implement"],
  submit_for_verification: ["implement"],
  submit_result: ["refine", "implement"],
  run_reviewer: ["verify"],
  submit_verdict: ["verify"],
};

export type McpErrorCode =
  // Without run token, unknown or from an already closed Run.
  | "invalid_run_token"
  | "tool_not_allowed"
  | "context_required"
  | "invalid_handoff"
  // Handoff with a taskId, runId or phase that are not the Run's.
  | "handoff_mismatch"
  | "no_approved_spec"
  // Handoff criteria or tasks that do not match the approved spec.
  | "spec_mismatch"
  | "commits_missing"
  // submit_result in implementation with a branch that already has commits on top of the base.
  | "branch_has_commits"
  // The committed diff contains only docs although the approved spec requires code.
  | "docs_only_diff"
  // Git could not determine the committed diff against the project's base branch.
  | "changed_files_unavailable"
  | "dirty_worktree"
  // A test gate is already running for this Run.
  | "gate_in_progress"
  | "test_gate_failed"
  // A pass on a HEAD different from the one that passed the submit_for_verification gate.
  | "head_changed"
  | "verdict_already_recorded"
  // A reported reviewer that does not appear in the Run's hooks, or an omitted one that did run.
  | "reviewer_evidence_mismatch"
  | "reviewer_execution_unavailable"
  | "reviewer_execution_failed"
  | "reviewer_already_running"
  // A phase hook with block policy failed: the task went to needs_human.
  | "hook_blocked"
  | "no_worktree"
  // The state machine rejected the transition (task state, guard or actor).
  | "transition_rejected";

export type McpError = {
  code: McpErrorCode;
  message: string;
  issues?: HandoffError[];
  output?: string;
};

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: McpError };

const fail = (code: McpErrorCode, message: string, extra: Partial<McpError> = {}) =>
  ({ ok: false, error: { code, message, ...extra } }) as const;

const AFTER_VERDICT: readonly ToolName[] = ["get_task_context", "submit_verdict"];

const HANDOFF_PHASE: Readonly<Record<Phase, HandoffPhase | null>> = {
  refine: "refinement",
  implement: "implementation",
  verify: "verification",
  deliver: null,
};

// Rolls back the transaction of a rejected write and carries the rejection to the caller.
class Rejected extends Error {
  readonly failure: { ok: false; error: McpError };

  constructor(failure: { ok: false; error: McpError }) {
    super(failure.error.message);
    this.failure = failure;
  }
}

export interface McpServiceDeps {
  db: LunasqDatabase;
  testGate: TestGate;
  commitVerifier: CommitVerifier;
  phaseHooks: PhaseHooks;
  copilotReviewers?: CopilotReviewerExecutor;
}

export class LunasqMcpService {
  readonly #db: LunasqDatabase;
  readonly #runs: RunRepository;
  readonly #specs: SpecRepository;
  readonly #projects: ProjectRepository;
  readonly #tasks: TaskRepository;
  readonly #testGate: TestGate;
  readonly #commits: CommitVerifier;
  readonly #hooks: PhaseHooks;
  readonly #subagents: RunSubagentRepository;
  readonly #copilotReviewers: CopilotReviewerExecutor | undefined;
  readonly #reviewersInFlight = new Set<string>();
  // Runs with a test gate in progress: a retry does not launch a second suite in parallel.
  readonly #gating = new Set<string>();

  constructor(deps: McpServiceDeps) {
    this.#db = deps.db;
    this.#runs = new RunRepository(deps.db);
    this.#specs = new SpecRepository(deps.db);
    this.#projects = new ProjectRepository(deps.db);
    this.#tasks = new TaskRepository(deps.db);
    this.#testGate = deps.testGate;
    this.#commits = deps.commitVerifier;
    this.#hooks = deps.phaseHooks;
    this.#subagents = new RunSubagentRepository(deps.db);
    this.#copilotReviewers = deps.copilotReviewers;
  }

  /** Common guards: active Run, tool of its phase and context read (except get_task_context). */
  authorize(token: string | undefined, tool: ToolName): Outcome<RunRow> {
    const run = token ? this.#runs.activeByToken(token) : null;
    if (!run) {
      return fail(
        "invalid_run_token",
        "run token missing, unknown or from a closed Run: this session can no longer move the task",
      );
    }
    if (!TOOL_PHASES[tool].includes(run.phase)) {
      return fail("tool_not_allowed", `${tool} is not accepted in phase ${run.phase}`);
    }
    if (tool !== "get_task_context" && !run.contextReadAt) {
      return fail("context_required", `call get_task_context before ${tool}`);
    }
    // After a pass the Run stays open only for the delivery: the verifier no longer moves the task.
    if (run.phase === "verify" && run.handoff !== null && !AFTER_VERDICT.includes(tool)) {
      return fail(
        "tool_not_allowed",
        `the Run already recorded its verdict; ${tool} is not accepted`,
      );
    }
    return { ok: true, data: run };
  }

  getTaskContext(run: RunRow): Outcome<TaskContext> {
    const { task, project } = this.#taskAndProject(run);
    this.#runs.markContextRead(run.id);

    const approved = this.#specs.approved(task.id);
    const latest = run.phase === "refine" ? this.#specs.list(task.id)?.at(-1) : undefined;
    const previous = this.#runs.previousRun(task.id, run.phase, run.id);
    const context: TaskContext = {
      task: {
        id: task.id,
        number: task.number,
        intent: task.intent,
        title: task.title,
        tags: task.tags,
        state: task.state,
        subState: task.subState,
        verificationIteration: task.verificationIteration,
        branch: task.branch,
        worktreePath: task.worktreePath,
      },
      run: { id: run.id, phase: run.phase, iteration: run.iteration },
      project: {
        name: project.name,
        repo: project.repo,
        baseBranch: project.baseBranch,
        testCommand: project.testCommand ?? null,
      },
      approvedSpec: approved ? { version: approved.version, content: approved.content } : null,
      changesRequested:
        latest?.approval === "changes_requested"
          ? {
              version: latest.version,
              content: latest.content,
              comments: latest.reviewComments ?? "",
            }
          : null,
      implementation:
        this.#storedHandoffs(task.id, "implement").filter(isImplementation).at(-1) ?? null,
      // The implementer receives only the last reject's must-fix; the history is the verifier's.
      verificationHistory:
        run.phase === "verify"
          ? this.#storedHandoffs(task.id, "verify").filter(isVerification)
          : [],
      rework: run.phase === "implement" ? this.#rework(task.id) : null,
      deliveryConflict: run.phase === "implement" ? this.#deliveryConflict(task.id) : null,
      previousAttempt: previous
        ? {
            runId: previous.id,
            failureReason: previous.failureReason,
            handoff: previous.handoff ? (storedHandoff(previous.handoff) ?? null) : null,
          }
        : null,
      questions: listQuestions(this.#db, task.id).map((q) => ({
        id: q.id,
        question: q.question,
        context: q.context,
        options: q.options,
        status: q.status,
        answer: q.answer,
      })),
      checklist: latestChecklist(this.#db, task.id),
    };
    return { ok: true, data: context };
  }

  submitSpec(run: RunRow, input: unknown): Outcome<{ specVersion: number }> {
    const parsed = this.#parse(run, input, "refinement");
    if (!parsed.ok) return parsed;
    const { assumptions: _assumptions, title, ...content } = parsed.data.body;
    return this.#write((tx) => {
      this.#close(tx, run, { result: "success", handoff: parsed.data });
      const result = this.#specs.applySubmit(tx, run.taskId, content);
      if (!result.ok) throw new Rejected(fail("transition_rejected", result.error.message));
      applyTaskTitle(tx, run.taskId, title);
      return { ok: true, data: { specVersion: result.spec.version } };
    });
  }

  askHuman(run: RunRow, input: AskHumanInput): Outcome<{ questionId: string }> {
    return this.#write((tx) => {
      this.#transition(tx, { taskId: run.taskId, actor: "agent", command: { type: "ask_human" } });
      const question = createQuestion(tx, {
        taskId: run.taskId,
        runId: run.id,
        question: input.question,
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.options === undefined ? {} : { options: input.options }),
      });
      return { ok: true, data: { questionId: question.id } };
    });
  }

  updateChecklist(
    run: RunRow,
    input: UpdateChecklistInput,
  ): Outcome<{ checklist: ChecklistItem[] }> {
    const spec = this.#specs.approved(run.taskId);
    if (!spec) return fail("no_approved_spec", "the task has no approved spec");
    const known = new Set(spec.content.taskList.map((t) => t.id));
    const unknown = input.items.filter((i) => !known.has(i.taskId));
    if (unknown.length > 0) {
      return fail("spec_mismatch", "items that are not in the approved spec's task list", {
        issues: unknown.map((i) => ({
          path: `items[${input.items.indexOf(i)}].taskId`,
          message: `the approved spec has no task ${i.taskId}`,
        })),
      });
    }

    return this.#write((tx) => {
      const current = latestChecklist(tx, run.taskId);
      const done = new Map((current ?? []).map((i) => [i.taskId, i.done]));
      for (const item of input.items) done.set(item.taskId, item.done);
      const checklist = spec.content.taskList.map((t) => ({
        taskId: t.id,
        title: t.title,
        done: done.get(t.id) ?? false,
      }));
      // Repeating the same mark does not add another event.
      if (JSON.stringify(checklist) !== JSON.stringify(current)) {
        appendChecklist(tx, run.taskId, run.id, checklist);
      }
      return { ok: true, data: { checklist } };
    });
  }

  async runReviewer(run: RunRow, input: RunReviewerInput): Promise<Outcome<{ output: string }>> {
    if (run.agentKind !== "copilot" || !this.#copilotReviewers) {
      return fail(
        "reviewer_execution_unavailable",
        "run_reviewer is only available when Copilot CLI is the verification provider",
      );
    }
    const key = `${run.id}:${input.reviewer}`;
    if (this.#reviewersInFlight.has(key)) {
      return fail("reviewer_already_running", `${input.reviewer} is already running in this Run`);
    }
    const task = this.#tasks.get(run.taskId);
    if (!task?.worktreePath) return fail("no_worktree", "the task has no registered worktree");

    this.#reviewersInFlight.add(key);
    const agentId = `copilot-${randomUUID()}`;
    this.#subagents.recordStart(run.id, { agentId, agentType: input.reviewer });
    try {
      const result = await this.#copilotReviewers.run({
        run,
        worktreePath: task.worktreePath,
        agentId,
        reviewer: input.reviewer,
        instructions: input.instructions,
      });
      this.#subagents.recordStop(run.id, {
        agentId,
        agentType: input.reviewer,
        transcriptPath: result.transcriptPath,
      });
      return { ok: true, data: { output: result.output } };
    } catch (error) {
      return fail(
        "reviewer_execution_failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.#reviewersInFlight.delete(key);
    }
  }

  async submitForVerification(
    run: RunRow,
    input: unknown,
  ): Promise<Outcome<{ state: "verification" }>> {
    const parsed = this.#parse(run, input, "implementation");
    if (!parsed.ok) return parsed;
    const handoff = parsed.data;
    const spec = this.#specs.approved(run.taskId);
    if (!spec) return fail("no_approved_spec", "the task has no approved spec");
    const coverage = checkCriteria(
      spec,
      handoff.body.criterionTests.map((c) => c.criterionId),
      "body.criterionTests",
      "has no tests in criterionTests",
    );
    if (!coverage.ok) return coverage;

    const { task, project } = this.#taskAndProject(run);
    if (!task.worktreePath) return fail("no_worktree", "the task has no registered worktree");
    // After a blocked hook the task already escalated: a retry does not run hooks or the gate again.
    const moved = notRunning(task, "in_progress");
    if (moved) return moved;

    const worktreePath = task.worktreePath;
    const rejected = await this.#gated(run, () =>
      this.#checkWorktree(run, handoff, spec, worktreePath, project),
    );
    if (rejected) return rejected;
    return this.#write((tx) => {
      this.#close(tx, run, { result: "success", handoff });
      this.#transition(tx, {
        taskId: run.taskId,
        actor: "agent",
        command: {
          type: "submit_for_verification",
          testGatePassed: true,
          everyCriterionHasTest: true,
          hasCommits: true,
        },
        // The tests ran outside the transaction: the task must not have moved.
        expected: { state: "in_progress", subState: "running" },
      });
      return { ok: true, data: { state: "verification" } };
    });
  }

  /**
   * Code-less task (ADR 0007): the Result replaces the spec or the diff. It completes the task without
   * verification, delivery or PR. In implementation only if the branch has no commits on top of the
   * base: with code, the exit is submit_for_verification.
   */
  async submitResult(run: RunRow, input: unknown): Promise<Outcome<{ state: "completed" }>> {
    const parsed = parseResultHandoff(input);
    if (!parsed.success) {
      return fail("invalid_handoff", "the handoff does not meet the schema", {
        issues: parsed.errors,
      });
    }
    const handoff = parsed.data;
    const issues: HandoffError[] = [];
    if (handoff.phase !== HANDOFF_PHASE[run.phase]) {
      issues.push({
        path: "phase",
        message: `expected ${HANDOFF_PHASE[run.phase]} but got ${handoff.phase}`,
      });
    }
    if (handoff.taskId !== run.taskId) {
      issues.push({ path: "taskId", message: `the Run belongs to task ${run.taskId}` });
    }
    if (handoff.runId !== run.id) {
      issues.push({ path: "runId", message: `the active Run is ${run.id}` });
    }
    if (issues.length > 0) {
      return fail("handoff_mismatch", "the handoff does not match this Run", { issues });
    }

    const { task, project } = this.#taskAndProject(run);
    const origin = run.phase === "refine" ? "draft" : "in_progress";
    const moved = notRunning(task, origin);
    if (moved) return moved;
    if (run.phase === "implement") {
      if (!task.worktreePath) return fail("no_worktree", "the task has no registered worktree");
      if (
        await this.#commits.branchHasCommits({
          worktreePath: task.worktreePath,
          baseBranch: project.baseBranch,
        })
      ) {
        return fail(
          "branch_has_commits",
          `the task's branch has commits on top of ${project.baseBranch}: deliver with submit_for_verification`,
        );
      }
    }

    return this.#write((tx) => {
      this.#close(tx, run, { result: "success", handoff });
      const result = completeTaskWithResult(tx, {
        taskId: run.taskId,
        resultKind: handoff.resultKind,
        result: handoff.result,
        title: handoff.title,
        // The commit check ran outside the transaction: the task must not have moved.
        expected: { state: origin, subState: "running" },
      });
      if (!result.ok) {
        throw new Rejected(
          fail("transition_rejected", `${result.error.code}: ${result.error.message}`),
        );
      }
      return { ok: true, data: { state: "completed" } };
    });
  }

  async submitVerdict(
    run: RunRow,
    input: unknown,
  ): Promise<Outcome<{ verdict: "pass" | "reject" }>> {
    const parsed = this.#parse(run, input, "verification");
    if (!parsed.ok) return parsed;
    let handoff = parsed.data;
    const spec = this.#specs.approved(run.taskId);
    if (!spec) return fail("no_approved_spec", "the task has no approved spec");
    const coverage = checkCriteria(
      spec,
      handoff.body.criteriaVerdicts.map((c) => c.criterionId),
      "body.criteriaVerdicts",
      "has no verdict",
    );
    if (!coverage.ok) return coverage;

    // If the Run already recorded a verdict, the transaction decides (idempotent or
    // verdict_already_recorded) without checking evidence again, running the suite or the hooks.
    if (this.#runs.get(run.id)?.handoff === null) {
      // After a blocked hook the task already escalated: a retry does not run hooks or the gate again.
      const moved = notRunning(this.#taskAndProject(run).task, "verification");
      if (moved) return moved;
      const issues = checkReviewerEvidence(handoff.body, this.#subagents.forRun(run.id));
      if (issues.length > 0) {
        return fail(
          "reviewer_evidence_mismatch",
          "the verdict's reviewers do not match those recorded by the Run's hooks",
          { issues },
        );
      }
      const rejected = await this.#gated(run, async () => {
        // Before accepting a pass, LunasQ runs the suite again.
        const pass = handoff.body.verdict === "pass" ? await this.#checkPass(run) : null;
        if (pass && GIT_REWORK_CODES.has(pass.error.code)) {
          // The git state is fixed by the implementer: the Run closes as reject with a must-fix.
          handoff = gitReworkHandoff(handoff, pass.error);
        } else if (pass) {
          return pass;
        }
        return this.#runHooks(run, "after_verification", handoff.body.verdict);
      });
      if (rejected) return rejected;
    }

    return this.#write((tx) => {
      // A Run records a single verdict: repeating the same one changes nothing.
      const current = this.#runs.get(run.id);
      if (!current || current.endedAt) throw new Rejected(staleRun());
      if (current.handoff !== null) {
        if (JSON.stringify(current.handoff) === JSON.stringify(handoff)) {
          return { ok: true, data: { verdict: handoff.body.verdict } };
        }
        throw new Rejected(
          fail("verdict_already_recorded", "this Run already recorded a different verdict"),
        );
      }
      const { body } = handoff;
      const summary = {
        runId: run.id,
        verdict: body.verdict,
        iteration: run.iteration,
        riskLabel: body.riskLabel,
        mustFix: body.mustFix.length,
        refuted: body.refuted.length,
        skippedReviewers: REVIEWER_NAMES.filter((n) => body.reviewers[n].status === "skipped"),
      };
      if (body.verdict === "reject") {
        const { project } = this.#taskAndProject(run);
        this.#close(tx, run, { result: "success", handoff });
        // With the project cap reached, the state machine sends the task to needs_human.
        this.#transition(tx, {
          taskId: run.taskId,
          actor: "agent",
          command: { type: "verdict_rework", maxIterations: maxVerificationIterations(project) },
          expected: { state: "verification", subState: "running" },
        });
        recordVerdict(tx, run.taskId, summary);
        return { ok: true, data: { verdict: "reject" } };
      }
      // Pass: the Run stays open and the delivery (UW-26) emits verdict_pass after creating the PR; the
      // verification.verdict_recorded event starts it.
      const task = this.#tasks.get(run.taskId);
      if (task?.state !== "verification" || task.subState !== "running") {
        throw new Rejected(fail("transition_rejected", "the task is not in verification/running"));
      }
      this.#runs.recordHandoff(run.id, handoff);
      recordVerdict(tx, run.taskId, summary);
      return { ok: true, data: { verdict: "pass" } };
    });
  }

  reportFailure(run: RunRow, input: ReportFailureInput): Outcome<{ attempt: number }> {
    return this.#write((tx) => {
      const attempt = consecutiveFailures(tx, run.taskId, run.phase) + 1;
      this.#close(tx, run, { result: "failure", failureReason: input.reason });
      // The agent declares the failure; whoever records it in the state machine is the system.
      this.#transition(tx, {
        taskId: run.taskId,
        actor: "system",
        command: { type: "run_failed", attempt },
      });
      return { ok: true, data: { attempt } };
    });
  }

  #parse<P extends HandoffPhase>(
    run: RunRow,
    input: unknown,
    phase: P,
  ): Outcome<Extract<Handoff, { phase: P }>> {
    const parsed = parseHandoff(input);
    if (!parsed.success) {
      return fail("invalid_handoff", "the handoff does not meet the schema", {
        issues: parsed.errors,
      });
    }
    const handoff = parsed.data;
    const issues: HandoffError[] = [];
    if (handoff.phase !== phase || HANDOFF_PHASE[run.phase] !== phase) {
      issues.push({ path: "phase", message: `expected ${phase} but got ${handoff.phase}` });
    }
    if (handoff.taskId !== run.taskId) {
      issues.push({ path: "taskId", message: `the Run belongs to task ${run.taskId}` });
    }
    if (handoff.runId !== run.id) {
      issues.push({ path: "runId", message: `the active Run is ${run.id}` });
    }
    if (issues.length > 0) {
      return fail("handoff_mismatch", "the handoff does not match this Run", { issues });
    }
    return { ok: true, data: handoff as Extract<Handoff, { phase: P }> };
  }

  /**
   * Runs `check` with the Run's lock: while a gate runs, another call of the same Run does not
   * launch a second suite.
   */
  async #gated(
    run: RunRow,
    check: () => Promise<Extract<Outcome<never>, { ok: false }> | null>,
  ): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    if (this.#gating.has(run.id)) {
      return fail(
        "gate_in_progress",
        "a test gate is already running for this Run; wait for its result",
      );
    }
    this.#gating.add(run.id);
    try {
      return await check();
    } finally {
      this.#gating.delete(run.id);
    }
  }

  /**
   * Before accepting a pass: clean worktree, HEAD at the commit that passed the
   * `submit_for_verification` gate and green gate again; null if everything passes. This way the verifier cannot
   * approve its own commit that, for example, deletes the red tests.
   */
  async #checkPass(run: RunRow): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    const { task, project } = this.#taskAndProject(run);
    const worktreePath = task.worktreePath;
    if (!worktreePath) return fail("no_worktree", "the task has no registered worktree");
    const expected = this.#gatedHead(run.taskId);
    // The verifier's reversion test touches the code: the gate runs on what is committed.
    const unchanged = async () =>
      (await this.#dirty(worktreePath)) ?? (await this.#sameHead(worktreePath, expected));
    const before = await unchanged();
    if (before) return before;
    const gate = await this.#runGate(run, worktreePath, project, "verdict_pass");
    if (gate) return gate;
    // The suite can take minutes: the worktree must not have moved while it ran.
    return unchanged();
  }

  /** Sha that the last green `submit_for_verification` gate of the task tested. */
  #gatedHead(taskId: string): string | null {
    let head: string | null = null;
    for (const event of listEvents(this.#db, taskId)) {
      if (event.type !== TEST_GATE_EXECUTED) continue;
      const payload = TestGateExecutedPayload.safeParse(event.payload);
      if (!payload.success || payload.data.trigger !== "submit_for_verification") continue;
      if (payload.data.passed) head = payload.data.headSha;
    }
    return head;
  }

  async #sameHead(
    worktreePath: string,
    expected: string | null,
  ): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    const head = await this.#commits.head(worktreePath);
    if (expected !== null) {
      if (head === expected) return null;
      // Closing a Run writes and sometimes commits the evidence after the implementer's gate.
      // If the intermediate commits only touch `lunasq/tasks/` they do not change the code, and the pass
      // gate runs on the current HEAD: the verdict keeps judging exactly what is tested.
      if (
        head !== null &&
        (await this.#commits.onlyEvidenceBetween({
          worktreePath,
          from: expected,
          to: head,
        }))
      ) {
        return null;
      }
    }
    return fail(
      "head_changed",
      expected === null
        ? "there is no green submit_for_verification gate to compare the HEAD against"
        : `the worktree HEAD (${head ?? "unreadable"}) is not the commit that passed the submit_for_verification gate (${expected})`,
    );
  }

  async #dirty(worktreePath: string): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    const dirty = await this.#commits.uncommitted(worktreePath);
    if (dirty.length === 0) return null;
    return fail("dirty_worktree", "the worktree has uncommitted changes", {
      issues: dirty.map((file) => ({ path: file, message: "uncommitted change" })),
    });
  }

  async #runGate(
    run: RunRow,
    worktreePath: string,
    project: { testCommand?: string | null },
    trigger: TestGateTrigger,
  ): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    // The gate is run by LunasQ on what is committed: what the agent says about its tests does not count.
    const gate = await this.#testGate.run({
      taskId: run.taskId,
      runId: run.id,
      worktreePath,
      command: project.testCommand ?? null,
      trigger,
    });
    if (!gate.passed) {
      return fail("test_gate_failed", "the test gate is red", { output: gate.output });
    }
    return null;
  }

  /** Commits of the branch, clean worktree and green test gate; null if everything passes. */
  async #checkWorktree(
    run: RunRow,
    handoff: ImplementationHandoff,
    spec: Spec,
    worktreePath: string,
    project: { baseBranch: string; testCommand?: string | null },
  ): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    const dirty = await this.#dirty(worktreePath);
    if (dirty) return dirty;
    const missing = await this.#commits.missing({
      worktreePath,
      baseBranch: project.baseBranch,
      commits: handoff.body.commits,
    });
    if (missing.length > 0) {
      return fail("commits_missing", "commits that are not in the task's branch", {
        issues: missing.map((sha) => ({
          path: `body.commits[${handoff.body.commits.indexOf(sha)}]`,
          message: `${sha} is not in the task's branch or is already in ${project.baseBranch}`,
        })),
      });
    }
    // Hooks run before the gate: this way the suite tests the HEAD with what they commit and the
    // verifier is dispatched when they have already finished.
    for (const point of ["after_implementation", "before_verification"] as const) {
      const blocked = await this.#runHooks(run, point);
      if (blocked) return blocked;
    }
    const changedFiles = await this.#commits.changedFiles({
      worktreePath,
      baseBranch: project.baseBranch,
    });
    if (changedFiles === null) {
      return fail(
        "changed_files_unavailable",
        `could not determine the files changed from ${project.baseBranch}`,
      );
    }
    const sourceFiles = changedFiles.filter((file) => !file.startsWith("lunasq/tasks/"));
    if (
      spec.content.deliverable !== "docs" &&
      sourceFiles.length > 0 &&
      sourceFiles.every((file) => file.endsWith(".md") || file.startsWith("docs/"))
    ) {
      return fail(
        "docs_only_diff",
        "this branch only changes documentation but the approved spec declares code. For research, remove the report and its task-only commits, then use submit_result; if those commits cannot safely be discarded, ask the human. For explicitly requested repository documentation, ask the human to reopen the spec with deliverable: docs.",
      );
    }
    return this.#runGate(run, worktreePath, project, "submit_for_verification");
  }

  /** Hooks of the point; null if it did not block. A blocked point already escalated the task (HookService). */
  async #runHooks(
    run: RunRow,
    point: HookPoint,
    phaseResult?: string,
  ): Promise<Extract<Outcome<never>, { ok: false }> | null> {
    const result = await this.#hooks.run({
      taskId: run.taskId,
      point,
      runId: run.id,
      ...(phaseResult === undefined ? {} : { phaseResult }),
    });
    if (result.outcome !== "blocked") return null;
    const where = result.failedScript ? ` in ${result.failedScript}` : "";
    return fail(
      "hook_blocked",
      `point ${point} blocked${where}${result.escalated ? ": the task went to needs_human" : ""}`,
      result.error ? { output: result.error } : {},
    );
  }

  /** Must-fix of the last verdict if it was reject; null if there is none or if the last was pass. */
  #rework(taskId: string): TaskContext["rework"] {
    const latest = this.#runs.latestHandoff(taskId, "verify");
    const handoff = latest ? storedHandoff(latest.handoff) : undefined;
    if (!latest || !handoff || !isVerification(handoff) || handoff.body.verdict !== "reject") {
      return null;
    }
    return { runId: latest.runId, iteration: latest.iteration, mustFix: handoff.body.mustFix };
  }

  /** The most recent delivery conflict, while there is no later verdict (ADR uw-26-entrega). */
  #deliveryConflict(taskId: string): TaskContext["deliveryConflict"] {
    let conflict: TaskContext["deliveryConflict"] = null;
    for (const event of listEvents(this.#db, taskId)) {
      if (event.type === VERDICT_RECORDED) conflict = null;
      else if (event.type === DELIVERY_CONFLICT) {
        const parsed = DeliveryConflictPayload.safeParse(event.payload);
        if (parsed.success) conflict = parsed.data;
      }
    }
    return conflict;
  }

  #taskAndProject(run: RunRow) {
    const task = this.#tasks.get(run.taskId);
    const project = task ? this.#projects.get(task.projectId) : null;
    if (!task || !project) {
      throw new Error(`Run ${run.id} points to a nonexistent task or project`);
    }
    return { task, project };
  }

  #storedHandoffs(taskId: string, phase: Phase): Handoff[] {
    return this.#runs
      .handoffs(taskId, phase)
      .map(storedHandoff)
      .filter((h): h is Handoff => h !== undefined);
  }

  #close(tx: Tx, run: RunRow, input: Parameters<typeof closeRun>[2]): void {
    if (!closeRun(tx, run.id, input)) throw new Rejected(staleRun());
  }

  #transition(tx: Tx, input: TransitionTaskInput): void {
    const result = applyTransition(tx, input);
    if (!result.ok) {
      throw new Rejected(
        fail("transition_rejected", `${result.error.code}: ${result.error.message}`),
      );
    }
  }

  #write<T>(fn: (tx: Tx) => Outcome<T>): Outcome<T> {
    try {
      return this.#db.transaction(fn, { behavior: "immediate" });
    } catch (error) {
      if (error instanceof Rejected) return error.failure;
      throw error;
    }
  }
}

const staleRun = () =>
  fail(
    "invalid_run_token",
    "the Run was closed while the call was running: this session is no longer the active one",
  );

/** Rejection without effects if the task is no longer in `<state>/running` (e.g. it escalated to needs_human). */
function notRunning(task: { state: string; subState: string | null }, state: string) {
  if (task.state === state && task.subState === "running") return null;
  return fail(
    "transition_rejected",
    `the task is in ${task.state}${task.subState ? `/${task.subState}` : ""}, not in ${state}/running`,
  );
}

function storedHandoff(value: unknown): Handoff | undefined {
  const parsed = parseHandoff(value);
  return parsed.success ? parsed.data : undefined;
}

type ImplementationHandoff = Extract<Handoff, { phase: "implementation" }>;
type VerificationHandoff = Extract<Handoff, { phase: "verification" }>;

const isImplementation = (h: Handoff): h is ImplementationHandoff => h.phase === "implementation";
const isVerification = (h: Handoff): h is VerificationHandoff => h.phase === "verification";

/** The handoff ids must be exactly the approved spec's criteria. */
function checkCriteria(
  spec: Spec,
  ids: string[],
  path: string,
  missingMessage: string,
): Outcome<null> {
  const expected = new Set(spec.content.criteria.map((c) => c.id));
  const issues: HandoffError[] = [];
  ids.forEach((id, i) => {
    if (!expected.has(id)) {
      issues.push({
        path: `${path}[${i}]`,
        message: `the approved spec has no criterion ${id}`,
      });
    }
  });
  for (const id of expected) {
    if (!ids.includes(id)) issues.push({ path, message: `criterion ${id} ${missingMessage}` });
  }
  if (issues.length > 0) {
    return fail(
      "spec_mismatch",
      `the handoff does not cover the criteria of spec v${spec.version}`,
      {
        issues,
      },
    );
  }
  return { ok: true, data: null };
}
