// Contract tests of each LunasQ MCP tool, through the official MCP client.
import {
  appendEvent,
  closeRun,
  createQuestion,
  listEvents,
  ProjectRepository,
  RunRepository,
  RunSubagentRepository,
  SettingsRepository,
  SpecRepository,
  transitionTask,
} from "@lunasq/db";
import { insertRun, setTaskPosition } from "@lunasq/db/test-helpers";
import { specContentExample } from "@lunasq/schemas/testing";
import { describe, expect, it, vi } from "vitest";
import { handoffFor, mcpHarness, resultFor } from "./test-helpers.ts";

const refining = { state: "draft", subState: "running" } as const;
const implementing = { state: "in_progress", subState: "running" } as const;
const verifying = { state: "verification", subState: "running" } as const;

const runOf = (h: ReturnType<typeof mcpHarness>, id: string) => new RunRepository(h.db).get(id);

describe("get_task_context", () => {
  it("implementation receives goal, project, approved spec and checklist", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.session("implement", implementing);
    const { isError, body } = await call("get_task_context");
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      task: {
        id: task.id,
        number: task.number,
        goal: task.goal,
        state: "in_progress",
        worktreePath: "/wt/tarea",
      },
      run: { id: run.id, phase: "implement", iteration: 0 },
      project: { baseBranch: "main", testCommand: "pnpm test" },
      approvedSpec: { version: 1, content: specContentExample() },
      changesRequested: null,
      implementation: null,
      verificationHistory: [],
      previousAttempt: null,
      questions: [],
      checklist: null,
    });
  });

  it("refinement after requested changes receives the version and its comments", async () => {
    const h = mcpHarness();
    const task = h.task(refining, { approved: false });
    const specs = new SpecRepository(h.db);
    const submitted = specs.submit(task.id, specContentExample());
    if (!submitted.ok) throw new Error(submitted.error.message);
    const changes = specs.requestChanges(task.id, 1, "Falta el caso de reembolso");
    expect(changes.ok).toBe(true);
    setTaskPosition(h.db, task.id, refining);
    const run = insertRun(h.db, task.id, { phase: "refine" });
    const { call } = await h.connect(run.runToken);
    const { body } = await call("get_task_context");
    expect(body).toMatchObject({
      approvedSpec: null,
      changesRequested: { version: 1, comments: "Falta el caso de reembolso" },
    });
  });

  it("verification receives the implementation handoff, the history and the previous attempt", async () => {
    const h = mcpHarness();
    const task = h.task(verifying);
    const impl = insertRun(h.db, task.id, { phase: "implement", startedAt: new Date(1000) });
    closeRun(h.db, impl.id, { result: "success", handoff: handoffFor("implementation", impl) });
    const verify1 = insertRun(h.db, task.id, { phase: "verify", startedAt: new Date(2000) });
    const reject = handoffFor("verification-reject", verify1);
    closeRun(h.db, verify1.id, { result: "success", handoff: reject });
    const run = insertRun(h.db, task.id, { phase: "verify", iteration: 1 });
    const question = createQuestion(h.db, { taskId: task.id, runId: run.id, question: "¿Ok?" });
    const { call } = await h.connect(run.runToken);
    const { body } = await call("get_task_context");
    expect(body).toMatchObject({
      implementation: { runId: impl.id, phase: "implementation" },
      verificationHistory: [{ runId: verify1.id, body: { verdict: "reject" } }],
      previousAttempt: { runId: verify1.id, failureReason: null, handoff: { runId: verify1.id } },
      questions: [{ id: question.id, question: "¿Ok?", status: "open", answer: null }],
    });
  });

  it("after a reject, implementation receives only the must-fix and not the history", async () => {
    const h = mcpHarness();
    const task = h.task(implementing);
    const verify1 = insertRun(h.db, task.id, {
      phase: "verify",
      iteration: 0,
      startedAt: new Date(1000),
    });
    const reject = handoffFor("verification-reject", verify1);
    closeRun(h.db, verify1.id, { result: "success", handoff: reject });
    const run = insertRun(h.db, task.id, { phase: "implement", iteration: 1 });
    const { call } = await h.connect(run.runToken);
    const { body } = await call("get_task_context");
    expect(body).toMatchObject({
      verificationHistory: [],
      rework: { runId: verify1.id, iteration: 0, mustFix: reject.body.mustFix },
    });
  });

  it("without a previous reject, or with a pass as the last verdict, there is no rework", async () => {
    const h = mcpHarness();
    const task = h.task(implementing);
    const verify1 = insertRun(h.db, task.id, { phase: "verify", startedAt: new Date(1000) });
    closeRun(h.db, verify1.id, {
      result: "success",
      handoff: handoffFor("verification-pass", verify1),
    });
    // A delivery conflict sends it back to implementation without verifier rework.
    const run = insertRun(h.db, task.id, { phase: "implement" });
    const { call } = await h.connect(run.runToken);
    expect((await call("get_task_context")).body).toMatchObject({ rework: null });
  });

  it("after a delivery conflict, implementation receives what caused it until the next verdict", async () => {
    const h = mcpHarness();
    const task = h.task(implementing);
    const verify1 = insertRun(h.db, task.id, { phase: "verify", startedAt: new Date(1000) });
    closeRun(h.db, verify1.id, {
      result: "success",
      handoff: handoffFor("verification-pass", verify1),
    });
    const conflict = {
      runId: verify1.id,
      reason: "rebase_conflict",
      baseBranch: "main",
      files: ["src/a.ts"],
      output: null,
    };
    appendEvent(h.db, {
      taskId: task.id,
      type: "delivery.conflict",
      actor: "system",
      payload: conflict,
    });
    const run = insertRun(h.db, task.id, { phase: "implement" });
    const { call } = await h.connect(run.runToken);
    expect((await call("get_task_context")).body).toMatchObject({
      rework: null,
      deliveryConflict: conflict,
    });

    // The implementer delivered and the verifier recorded a new verdict: the conflict is behind.
    appendEvent(h.db, {
      taskId: task.id,
      type: "verification.verdict_recorded",
      actor: "agent",
      payload: {
        runId: verify1.id,
        verdict: "pass",
        iteration: 0,
        riskLabel: "low",
        mustFix: 0,
        refuted: 0,
        skippedReviewers: [],
      },
    });
    expect((await call("get_task_context")).body).toMatchObject({ deliveryConflict: null });
  });

  it("verification receives no rework", async () => {
    const h = mcpHarness();
    const { call } = await h.session("verify", verifying);
    expect((await call("get_task_context")).body).toMatchObject({ rework: null });
  });

  it("repeating it does not move the read mark", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("implement", implementing);
    const first = runOf(h, run.id)?.contextReadAt?.getTime();
    await call("get_task_context");
    expect(runOf(h, run.id)?.contextReadAt?.getTime()).toBe(first);
  });
});

describe("submit_spec", () => {
  it("creates the version, moves the task to refined and closes the Run with the handoff", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("refine", refining, { approved: false });
    const handoff = handoffFor("refinement", run);
    const result = await call("submit_spec", { handoff });
    expect(result).toEqual({ isError: false, body: { specVersion: 1 } });
    expect(h.taskOf(task.id)).toMatchObject({ state: "refined", subState: null });
    const spec = new SpecRepository(h.db).get(task.id, 1);
    expect(spec?.content).not.toHaveProperty("assumptions");
    expect(spec?.content.taskList.map((t) => t.id)).toEqual(["T-1", "T-2"]);
    expect(runOf(h, run.id)).toMatchObject({ result: "success", handoff });
    expect(runOf(h, run.id)?.endedAt).toBeInstanceOf(Date);
  });

  it("saves the handoff title on the task, without putting it in the spec", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("refine", refining, { approved: false });
    expect(h.taskOf(task.id)?.title).toBeNull();
    const handoff = handoffFor("refinement", run);
    handoff.body = { ...handoff.body, title: "Cancelar pedidos" };
    await call("submit_spec", { handoff });
    expect(h.taskOf(task.id)?.title).toBe("Cancelar pedidos");
    expect(new SpecRepository(h.db).get(task.id, 1)?.content).not.toHaveProperty("title");
    expect(listEvents(h.db, task.id).filter((e) => e.type === "task.titled")).toHaveLength(1);
  });

  it("a later refinement does not change the title", async () => {
    const h = mcpHarness();
    const task = h.task(refining, { approved: false });
    const first = insertRun(h.db, task.id, { phase: "refine" });
    const one = await h.connect(first.runToken);
    await one.call("get_task_context");
    const firstHandoff = handoffFor("refinement", first);
    firstHandoff.body = { ...firstHandoff.body, title: "Primer título" };
    await one.call("submit_spec", { handoff: firstHandoff });
    expect(new SpecRepository(h.db).requestChanges(task.id, 1, "Falta algo").ok).toBe(true);
    setTaskPosition(h.db, task.id, refining);

    const second = insertRun(h.db, task.id, { phase: "refine", iteration: 1 });
    const two = await h.connect(second.runToken);
    await two.call("get_task_context");
    const secondHandoff = handoffFor("refinement", second);
    secondHandoff.body = { ...secondHandoff.body, title: "Otro título" };
    const result = await two.call("submit_spec", { handoff: secondHandoff });
    expect(result.isError).toBe(false);
    expect(h.taskOf(task.id)?.title).toBe("Primer título");
    expect(listEvents(h.db, task.id).filter((e) => e.type === "task.titled")).toHaveLength(1);
  });

  it("a handoff without a title is rejected", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("refine", refining, { approved: false });
    const handoff = handoffFor("refinement", run);
    const { title: _title, ...body } = handoff.body as Record<string, unknown>;
    handoff.body = body;
    const result = await call("submit_spec", { handoff });
    expect(result.body).toMatchObject({
      error: "invalid_handoff",
      issues: expect.arrayContaining([expect.objectContaining({ path: "body.title" })]),
    });
  });

  it("an invalid handoff is rejected with errors by path and writes nothing", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("refine", refining, { approved: false });
    const handoff = handoffFor("refinement", run);
    handoff.body = { ...handoff.body, criteria: [] };
    const result = await call("submit_spec", { handoff });
    expect(result.isError).toBe(true);
    expect(result.body).toMatchObject({
      error: "invalid_handoff",
      issues: expect.arrayContaining([expect.objectContaining({ path: "body.criteria" })]),
    });
    expect(new SpecRepository(h.db).list(task.id)).toEqual([]);
    expect(runOf(h, run.id)?.endedAt).toBeNull();
    // The agent fixes it and retries in the same Run.
    expect((await call("submit_spec", { handoff: handoffFor("refinement", run) })).isError).toBe(
      false,
    );
  });

  it("a handoff of another phase, task or Run is rejected with handoff_mismatch", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("refine", refining, { approved: false });
    const other = handoffFor("refinement", { id: "otro-run", taskId: "otra-tarea" });
    const mismatch = await call("submit_spec", { handoff: other });
    expect(mismatch.body).toMatchObject({
      error: "handoff_mismatch",
      issues: [{ path: "taskId" }, { path: "runId" }],
    });
    const wrongPhase = await call("submit_spec", { handoff: handoffFor("implementation", run) });
    expect(wrongPhase.body).toMatchObject({
      error: "handoff_mismatch",
      issues: [{ path: "phase" }],
    });
  });

  it("if the state machine rejects, no version or closed Run is left", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready(
      "refine",
      { state: "draft", subState: "queued" },
      {
        approved: false,
      },
    );
    const result = await call("submit_spec", { handoff: handoffFor("refinement", run) });
    expect(result.body).toMatchObject({ error: "transition_rejected" });
    expect(new SpecRepository(h.db).list(task.id)).toEqual([]);
    expect(runOf(h, run.id)?.endedAt).toBeNull();
  });
});

describe("submit_result", () => {
  it("AC-1: in refinement it completes the task without a PR with Result, title and closed Run", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("refine", refining, { approved: false });
    expect(h.taskOf(task.id)?.title).toBeNull();
    const handoff = resultFor(run);

    const result = await call("submit_result", { handoff });

    expect(result).toEqual({ isError: false, body: { state: "completed" } });
    expect(h.taskOf(task.id)).toMatchObject({
      state: "completed",
      subState: null,
      resultKind: "research",
      result: "# Hallazgos\n\nSQLite basta para un solo proceso.",
      title: "Elegir la base de datos",
      prUrl: null,
      prState: null,
    });
    expect(runOf(h, run.id)).toMatchObject({ result: "success", handoff });
    expect(runOf(h, run.id)?.endedAt).toBeInstanceOf(Date);
    const events = listEvents(h.db, task.id);
    expect(events.filter((e) => e.type === "task.titled")).toHaveLength(1);
    expect(events.filter((e) => e.type === "task.transitioned").at(-1)).toMatchObject({
      actor: "agent",
      payload: {
        command: "submit_result",
        from: { state: "draft", subState: "running" },
        to: { state: "completed", subState: null },
        note: "research",
      },
    });
    // Without verification or delivery: there is no verdict or gate.
    expect(events.some((e) => e.type === "verification.verdict_recorded")).toBe(false);
    expect(h.testGate.calls).toHaveLength(0);
    expect(new SpecRepository(h.db).list(task.id)).toEqual([]);
  });

  it("AC-2: in implementation without commits on the base it completes the task and keeps its title", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    const titleBefore = h.taskOf(task.id)?.title ?? null;
    const handoff = resultFor(run, {
      phase: "implementation",
      resultKind: "already_implemented",
      title: "Otro título",
    });

    const result = await call("submit_result", { handoff });

    expect(result).toEqual({ isError: false, body: { state: "completed" } });
    expect(h.commitVerifier.aheadCalls).toEqual([
      { worktreePath: "/wt/tarea", baseBranch: "main" },
    ]);
    expect(h.taskOf(task.id)).toMatchObject({
      state: "completed",
      subState: null,
      resultKind: "already_implemented",
      prUrl: null,
      prState: null,
    });
    // The title is only set if it is still null: an already titled task does not change it.
    expect(h.taskOf(task.id)?.title).toBe(titleBefore ?? "Otro título");
    expect(runOf(h, run.id)?.result).toBe("success");
    // No verifier is dispatched and the test gate is not run.
    expect(h.testGate.calls).toHaveLength(0);
    expect(h.phaseHooks.calls).toEqual([]);
  });

  it("AC-2: an already titled task keeps its title", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    h.db.$client.prepare("update tasks set title = 'Título previo' where id = ?").run(task.id);

    await call("submit_result", {
      handoff: resultFor(run, { phase: "implementation", resultKind: "not_resolvable" }),
    });

    expect(h.taskOf(task.id)).toMatchObject({
      title: "Título previo",
      resultKind: "not_resolvable",
    });
    expect(listEvents(h.db, task.id).filter((e) => e.type === "task.titled")).toHaveLength(0);
  });

  it("AC-3: with commits on the base it is rejected and the task and the Run stay as they were", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    h.commitVerifier.ahead = true;
    const eventsBefore = listEvents(h.db, task.id).length;

    const result = await call("submit_result", {
      handoff: resultFor(run, { phase: "implementation" }),
    });

    expect(result.isError).toBe(true);
    expect(result.body).toMatchObject({ error: "branch_has_commits" });
    expect(h.taskOf(task.id)).toMatchObject({ ...implementing, resultKind: null, result: null });
    expect(runOf(h, run.id)?.endedAt).toBeNull();
    expect(listEvents(h.db, task.id)).toHaveLength(eventsBefore);
    // The agent can continue with submit_for_verification in the same Run.
    h.commitVerifier.ahead = false;
    expect(
      (await call("submit_result", { handoff: resultFor(run, { phase: "implementation" }) }))
        .isError,
    ).toBe(false);
  });

  it("AC-3: without a worktree the branch cannot be checked", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    h.db.$client.prepare("update tasks set worktree_path = null where id = ?").run(task.id);
    const result = await call("submit_result", {
      handoff: resultFor(run, { phase: "implementation" }),
    });
    expect(result.body).toMatchObject({ error: "no_worktree" });
    expect(h.taskOf(task.id)).toMatchObject(implementing);
  });

  it("AC-4: in verification it is rejected with tool_not_allowed and the task does not change", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    const result = await call("submit_result", {
      handoff: resultFor(run, { phase: "implementation" }),
    });
    expect(result).toMatchObject({ isError: true, body: { error: "tool_not_allowed" } });
    expect(h.taskOf(task.id)).toMatchObject({ ...verifying, resultKind: null });
    expect(runOf(h, run.id)?.endedAt).toBeNull();
  });

  it.each([
    ["a type outside the three", { resultKind: "bug" }, "resultKind"],
    ["an empty text", { result: "" }, "result"],
    ["a text of more than 20,000 characters", { result: "x".repeat(20_001) }, "result"],
  ])(
    "AC-5: %s gives invalid_handoff with the path and the Run stays open",
    async (_n, override, path) => {
      const h = mcpHarness();
      const { task, run, call } = await h.ready("refine", refining, { approved: false });

      const result = await call("submit_result", { handoff: resultFor(run, override) });

      expect(result.isError).toBe(true);
      expect(result.body).toMatchObject({
        error: "invalid_handoff",
        issues: [expect.objectContaining({ path })],
      });
      expect(h.taskOf(task.id)).toMatchObject({ ...refining, resultKind: null, result: null });
      expect(runOf(h, run.id)?.endedAt).toBeNull();
      // Fix it and retry in the same Run.
      expect((await call("submit_result", { handoff: resultFor(run) })).isError).toBe(false);
    },
  );

  it("AC-6: taskId, runId or phase that are not the Run's give handoff_mismatch", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("refine", refining, { approved: false });

    const other = await call("submit_result", {
      handoff: resultFor({ id: "otro-run", taskId: "otra-tarea" }),
    });
    expect(other.body).toMatchObject({
      error: "handoff_mismatch",
      issues: [{ path: "taskId" }, { path: "runId" }],
    });
    const wrongPhase = await call("submit_result", {
      handoff: resultFor(run, { phase: "implementation" }),
    });
    expect(wrongPhase.body).toMatchObject({
      error: "handoff_mismatch",
      issues: [{ path: "phase" }],
    });
    expect(h.taskOf(task.id)).toMatchObject({ ...refining, resultKind: null });
    expect(runOf(h, run.id)?.endedAt).toBeNull();
  });

  it("if the task is no longer in running it does not write the Result", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("refine", refining, { approved: false });
    setTaskPosition(h.db, task.id, { state: "needs_human", subState: null });

    const result = await call("submit_result", { handoff: resultFor(run) });

    expect(result.body).toMatchObject({ error: "transition_rejected" });
    expect(h.taskOf(task.id)).toMatchObject({
      state: "needs_human",
      resultKind: null,
      title: null,
    });
    expect(runOf(h, run.id)?.endedAt).toBeNull();
  });

  it("a retry after completing answers invalid_run_token and changes nothing", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("refine", refining, { approved: false });
    await call("submit_result", { handoff: resultFor(run) });
    const again = await call("submit_result", { handoff: resultFor(run, { result: "otro" }) });
    expect(again.body).toMatchObject({ error: "invalid_run_token" });
    expect(h.taskOf(task.id)?.result).toBe("# Hallazgos\n\nSQLite basta para un solo proceso.");
  });
});

describe("ask_human", () => {
  it("records the Question, moves to waiting_human and returns immediately", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    const result = await call("ask_human", { question: "¿Migro los datos?", context: "hay 2M" });
    expect(result.isError).toBe(false);
    expect(h.taskOf(task.id)).toMatchObject({ state: "in_progress", subState: "waiting_human" });
    const { body } = await call("get_task_context");
    expect(body.questions).toEqual([
      {
        id: result.body.questionId,
        question: "¿Migro los datos?",
        context: "hay 2M",
        options: null,
        status: "open",
        answer: null,
      },
    ]);
    expect(runOf(h, run.id)?.endedAt).toBeNull();
  });

  it("with options it stores them in order and get_task_context returns them", async () => {
    const h = mcpHarness();
    const { task, call } = await h.ready("implement", implementing);
    const options = [
      { label: "Postgres", description: "ya está en el stack" },
      { label: "SQLite" },
      { label: "Archivo plano" },
    ];
    const result = await call("ask_human", { question: "¿Qué motor uso?", options });
    expect(result.isError).toBe(false);
    expect(h.taskOf(task.id)).toMatchObject({ state: "in_progress", subState: "waiting_human" });
    const { body } = await call("get_task_context");
    expect(body.questions).toEqual([
      expect.objectContaining({ id: result.body.questionId, options, status: "open" }),
    ]);
  });

  it.each([
    ["a single option", [{ label: "A" }]],
    ["seven options", Array.from({ length: 7 }, (_, i) => ({ label: `O${i}` }))],
    ["an empty label", [{ label: "" }, { label: "B" }]],
    ["labels that only differ in case", [{ label: "Sí" }, { label: "sí" }]],
    ["labels that only differ in whitespace", [{ label: "Sí" }, { label: " Sí  " }]],
  ])("rejects %s without creating the Question or moving the task", async (_name, options) => {
    const h = mcpHarness();
    const { task, call } = await h.ready("implement", implementing);
    const result = await call("ask_human", { question: "¿Cuál?", options });
    expect(result.isError).toBe(true);
    expect(h.taskOf(task.id)).toMatchObject({ state: "in_progress", subState: "running" });
    expect((await call("get_task_context")).body.questions).toEqual([]);
    expect(listEvents(h.db, task.id).filter((e) => e.type === "question.created")).toHaveLength(0);
  });

  it("with the task already waiting for the human it is rejected without creating another Question", async () => {
    const h = mcpHarness();
    const { task, call } = await h.ready("implement", implementing);
    await call("ask_human", { question: "¿Uno?" });
    const again = await call("ask_human", { question: "¿Dos?" });
    expect(again.body).toMatchObject({ error: "transition_rejected" });
    expect(listEvents(h.db, task.id).filter((e) => e.type === "question.created")).toHaveLength(1);
  });

  it("validates the input", async () => {
    const h = mcpHarness();
    const { call } = await h.ready("implement", implementing);
    expect((await call("ask_human", { question: "" })).isError).toBe(true);
  });
});

describe("update_checklist", () => {
  it("marks items of the approved task list and returns the full checklist", async () => {
    const h = mcpHarness();
    const { task, call } = await h.ready("implement", implementing);
    const result = await call("update_checklist", { items: [{ taskId: "T-1", done: true }] });
    const checklist = [{ taskId: "T-1", title: "Comando CancelOrder en el agregado", done: true }];
    expect(result).toEqual({ isError: false, body: { checklist } });
    expect((await call("get_task_context")).body.checklist).toEqual(checklist);

    // Repeating the same mark does not add another event.
    await call("update_checklist", { items: [{ taskId: "T-1", done: true }] });
    expect(listEvents(h.db, task.id).filter((e) => e.type === "checklist.updated")).toHaveLength(1);
  });

  it("rejects items that are not in the approved spec", async () => {
    const h = mcpHarness();
    const { call } = await h.ready("implement", implementing);
    const result = await call("update_checklist", { items: [{ taskId: "T-9", done: true }] });
    expect(result.body).toMatchObject({
      error: "spec_mismatch",
      issues: [{ path: "items[0].taskId" }],
    });
  });
});

describe("submit_for_verification", () => {
  it("with a green gate and branch commits it moves to verification and closes the Run", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    const handoff = handoffFor("implementation", run);
    const result = await call("submit_for_verification", { handoff });
    expect(result).toEqual({ isError: false, body: { state: "verification" } });
    expect(h.taskOf(task.id)).toMatchObject({ state: "verification", subState: "queued" });
    expect(runOf(h, run.id)).toMatchObject({ result: "success", handoff });
    expect(h.testGate.calls).toEqual([
      {
        taskId: task.id,
        runId: run.id,
        worktreePath: "/wt/tarea",
        command: "pnpm test",
        trigger: "submit_for_verification",
      },
    ]);
    expect(h.commitVerifier.calls[0]).toMatchObject({
      baseBranch: "main",
      worktreePath: "/wt/tarea",
    });
  });

  it("rejects a documentation-only branch when the approved spec declares code", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    h.commitVerifier.changed = ["docs/research.md", "lunasq/tasks/1.md"];

    const result = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });

    expect(result).toMatchObject({
      isError: true,
      body: {
        error: "docs_only_diff",
        message: expect.stringContaining("submit_result"),
      },
    });
    expect(result.body.message).toContain("reopen the spec with deliverable: docs");
    expect(h.testGate.calls).toHaveLength(0);
    expect(h.taskOf(task.id)).toMatchObject(implementing);
    expect(runOf(h, run.id)?.endedAt).toBeNull();
  });

  it("allows a documentation-only branch when the approved spec declares docs", async () => {
    const h = mcpHarness({ deliverable: "docs" });
    const { task, run, call } = await h.ready("implement", implementing);
    h.commitVerifier.changed = ["README.md", "lunasq/tasks/1.md"];

    const result = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });

    expect(result).toEqual({ isError: false, body: { state: "verification" } });
    expect(h.taskOf(task.id)).toMatchObject({ state: "verification", subState: "queued" });
    expect(h.testGate.calls).toHaveLength(1);
  });

  it("allows mixed documentation and code changes for the default code deliverable", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("implement", implementing);
    h.commitVerifier.changed = ["docs/research.md", "src/app.ts"];

    const result = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });

    expect(result).toEqual({ isError: false, body: { state: "verification" } });
    expect(h.testGate.calls).toHaveLength(1);
  });

  it("fails closed when git cannot report the changed files", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    h.commitVerifier.changed = null;

    const result = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });

    expect(result.body).toMatchObject({ error: "changed_files_unavailable" });
    expect(h.testGate.calls).toHaveLength(0);
    expect(h.taskOf(task.id)).toMatchObject(implementing);
  });

  it("runs after_implementation and before_verification before the gate", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    const order: string[] = [];
    h.testGate.run = async (input) => {
      order.push(`gate:${h.commitVerifier.headSha}`);
      return { passed: input.command !== null, output: "" };
    };
    // A hook that commits moves the HEAD: the gate runs on the new commit.
    h.phaseHooks.onRun = (input) => {
      order.push(input.point);
      if (input.point === "before_verification") h.commitVerifier.headSha = "d".repeat(40);
    };
    await call("submit_for_verification", { handoff: handoffFor("implementation", run) });
    expect(order).toEqual([
      "after_implementation",
      "before_verification",
      `gate:${"d".repeat(40)}`,
    ]);
    expect(h.phaseHooks.calls.map((c) => c.runId)).toEqual([run.id, run.id]);
    expect(h.taskOf(task.id)).toMatchObject({ state: "verification", subState: "queued" });
  });

  it("after a blocked hook, a retry does not run hooks or the gate again", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    h.phaseHooks.results.after_implementation = {
      outcome: "blocked",
      escalated: true,
      failedScript: "10-lint",
      error: null,
    };
    // Like HookService: the blocked point escalates the task; the Run stays open.
    h.phaseHooks.onRun = () =>
      setTaskPosition(h.db, task.id, { state: "needs_human", subState: null });
    const handoff = handoffFor("implementation", run);
    expect((await call("submit_for_verification", { handoff })).body).toMatchObject({
      error: "hook_blocked",
    });
    expect((await call("submit_for_verification", { handoff })).body).toMatchObject({
      error: "transition_rejected",
    });
    expect(h.phaseHooks.calls).toHaveLength(1);
    expect(h.testGate.calls).toHaveLength(0);
  });

  it("a blocked hook stops the call before the gate and does not transition", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    h.phaseHooks.results.after_implementation = {
      outcome: "blocked",
      escalated: true,
      failedScript: "10-lint",
      error: "lint en rojo",
    };
    const result = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });
    expect(result.body).toMatchObject({
      error: "hook_blocked",
      message: expect.stringContaining("needs_human"),
      output: "lint en rojo",
    });
    expect(h.phaseHooks.calls.map((c) => c.point)).toEqual(["after_implementation"]);
    expect(h.testGate.calls).toHaveLength(0);
    expect(h.taskOf(task.id)).toMatchObject(implementing);
    expect(runOf(h, run.id)?.endedAt).toBeNull();
  });

  it("a red suite blocks the transition even if the agent says otherwise", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    h.testGate.result = { passed: false, output: "FAIL order.test.ts" };
    const result = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });
    expect(result).toMatchObject({
      isError: true,
      body: { error: "test_gate_failed", output: "FAIL order.test.ts" },
    });
    expect(h.taskOf(task.id)).toMatchObject(implementing);
    expect(runOf(h, run.id)?.endedAt).toBeNull();
  });

  it("criteria without tests or foreign to the spec are rejected before running the gate", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("implement", implementing);
    const handoff = handoffFor("implementation", run);
    const tests = handoff.body.criterionTests as { criterionId: string }[];
    handoff.body.criterionTests = [{ ...tests[0], criterionId: "AC-7" }];
    const result = await call("submit_for_verification", { handoff });
    expect(result.body).toMatchObject({
      error: "spec_mismatch",
      issues: [
        { path: "body.criterionTests[0]", message: expect.stringContaining("AC-7") },
        { path: "body.criterionTests", message: expect.stringContaining("AC-1") },
        { path: "body.criterionTests", message: expect.stringContaining("AC-2") },
      ],
    });
    expect(h.testGate.calls).toHaveLength(0);
  });

  it("commits that are not in the task's branch are rejected", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    h.commitVerifier.absent.add("b7e04d9c2f");
    const result = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });
    expect(result.body).toMatchObject({
      error: "commits_missing",
      issues: [{ path: "body.commits[1]" }],
    });
    expect(h.taskOf(task.id)).toMatchObject(implementing);
  });

  it("an invalid handoff is rejected with its errors", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("implement", implementing);
    const handoff = handoffFor("implementation", run);
    handoff.body.commits = ["no-es-sha"];
    const result = await call("submit_for_verification", { handoff });
    expect(result.body).toMatchObject({
      error: "invalid_handoff",
      issues: [{ path: "body.commits[0]" }],
    });
  });

  it("if the dispatcher closed the Run and opened another while the gate ran, it does not transition", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    let next: { id: string } | undefined;
    h.testGate.run = async () => {
      closeRun(h.db, run.id, { result: "failure", failureReason: "timeout" });
      next = insertRun(h.db, task.id);
      return { passed: true, output: "" };
    };
    const result = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });
    expect(result.body).toMatchObject({ error: "invalid_run_token" });
    expect(h.taskOf(task.id)).toMatchObject(implementing);
    expect(runOf(h, run.id)).toMatchObject({ result: "failure", handoff: null });
    expect(next && runOf(h, next.id)).toMatchObject({ endedAt: null, handoff: null });
  });

  it("a worktree with uncommitted changes is rejected before the gate", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    h.commitVerifier.dirty = ["src/order.ts"];
    const result = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });
    expect(result.body).toMatchObject({
      error: "dirty_worktree",
      issues: [{ path: "src/order.ts" }],
    });
    expect(h.testGate.calls).toHaveLength(0);
    expect(h.taskOf(task.id)).toMatchObject(implementing);
  });

  it("a second submit while the gate runs is rejected without launching another suite", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    let release: (value: { passed: boolean; output: string }) => void = () => {};
    let started = 0;
    h.testGate.run = () => {
      started += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const handoff = handoffFor("implementation", run);
    const first = call("submit_for_verification", { handoff });
    await vi.waitFor(() => expect(started).toBe(1));
    const second = await call("submit_for_verification", { handoff });
    expect(second.body).toMatchObject({ error: "gate_in_progress" });
    release({ passed: true, output: "" });
    expect((await first).isError).toBe(false);
    expect(started).toBe(1);
    expect(h.taskOf(task.id)).toMatchObject({ state: "verification" });
  });

  it("if the task changed while the gate ran, it does not transition", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    h.testGate.run = async () => {
      setTaskPosition(h.db, task.id, { state: "needs_human", subState: null });
      return { passed: true, output: "" };
    };
    const result = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });
    expect(result.body).toMatchObject({ error: "transition_rejected" });
    expect(runOf(h, run.id)?.endedAt).toBeNull();
  });
});

describe("submit_verdict", () => {
  it("reject goes back to in_progress with iteration + 1 and closes the Run", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    const handoff = h.verdictFor("verification-reject", run);
    const result = await call("submit_verdict", { handoff });
    expect(result).toEqual({ isError: false, body: { verdict: "reject" } });
    expect(h.taskOf(task.id)).toMatchObject({
      state: "in_progress",
      subState: "queued",
      verificationIteration: 1,
    });
    expect(runOf(h, run.id)).toMatchObject({ result: "success", handoff });
  });

  it("pass stores the verdict with the Run open and does not transition: the delivery emits the pass", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    const handoff = h.verdictFor("verification-pass", run);
    expect(await call("submit_verdict", { handoff })).toEqual({
      isError: false,
      body: { verdict: "pass" },
    });
    expect(h.taskOf(task.id)).toMatchObject(verifying);
    expect(runOf(h, run.id)).toMatchObject({ handoff, endedAt: null });

    // Repeating the same verdict is idempotent and does not run the gate again; a different one is rejected.
    expect((await call("submit_verdict", { handoff })).isError).toBe(false);
    expect(h.testGate.calls).toHaveLength(1);
    const reject = await call("submit_verdict", {
      handoff: h.verdictFor("verification-reject", run),
    });
    expect(reject.body).toMatchObject({ error: "verdict_already_recorded" });
    expect(h.taskOf(task.id)).toMatchObject(verifying);
  });

  it("before accepting a pass, LunasQ runs the test gate in the worktree", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    await call("submit_verdict", { handoff: h.verdictFor("verification-pass", run) });
    expect(h.testGate.calls).toEqual([
      {
        taskId: task.id,
        runId: run.id,
        worktreePath: "/wt/tarea",
        command: "pnpm test",
        trigger: "verdict_pass",
      },
    ]);
  });

  it("a pass with a red suite is rejected even if the verifier says otherwise", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    h.testGate.result = { passed: false, output: "FAIL order.test.ts" };
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-pass", run),
    });
    expect(result).toMatchObject({
      isError: true,
      body: { error: "test_gate_failed", output: "FAIL order.test.ts" },
    });
    expect(h.taskOf(task.id)).toMatchObject(verifying);
    expect(runOf(h, run.id)).toMatchObject({ handoff: null, endedAt: null });

    // The Run stays open: the verifier can correct its verdict to reject. The 4 reviewers
    // already ran in this Run, so the reject reports all of them.
    const reject = h.verdictFor("verification-reject", run);
    const ran = { status: "ran", findings: [] };
    reject.body.reviewers = {
      ...(reject.body.reviewers as object),
      "lunasq-ux-reviewer": ran,
      "lunasq-ui-reviewer": ran,
    };
    expect((await call("submit_verdict", { handoff: reject })).body).toEqual({ verdict: "reject" });
  });

  it("a pass with a dirty worktree goes back to implementation with a git must-fix", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    h.commitVerifier.dirty = ["src/order.ts"];
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-pass", run),
    });
    expect(result.body).toEqual({ verdict: "reject" });
    expect(h.testGate.calls).toHaveLength(0);
    expect(h.taskOf(run.taskId)).toMatchObject({ state: "in_progress", subState: "queued" });
    expect(runOf(h, run.id)?.handoff).toMatchObject({
      body: {
        verdict: "reject",
        mustFix: [{ source: "approver", file: "src/order.ts" }],
      },
    });
  });

  it("the implementer receives the git must-fix after a refused pass", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    h.commitVerifier.dirty = ["src/order.ts"];
    await call("submit_verdict", { handoff: h.verdictFor("verification-pass", run) });
    const next = insertRun(h.db, run.taskId, { phase: "implement", iteration: 1 });
    const implementer = await h.connect(next.runToken);
    expect((await implementer.call("get_task_context")).body).toMatchObject({
      rework: { mustFix: [{ source: "approver", file: "src/order.ts" }] },
    });
  });

  it("a pass on a HEAD different from the one that passed the submit_for_verification gate goes back to implementation", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    // The verifier committed something of its own, e.g. deleting the red tests.
    h.commitVerifier.headSha = "b".repeat(40);
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-pass", run),
    });
    expect(result.body).toEqual({ verdict: "reject" });
    expect(h.testGate.calls).toHaveLength(0);
    expect(h.taskOf(run.taskId)).toMatchObject({ state: "in_progress", subState: "queued" });
    expect(runOf(h, run.id)?.handoff).toMatchObject({
      body: { verdict: "reject", mustFix: [{ source: "approver" }] },
    });
  });

  it("a pass accepts commits after the gate that only touch the evidence", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    // LunasQ or an agent committed lunasq/tasks/ after the implementer's gate: it is not code.
    h.commitVerifier.headSha = "b".repeat(40);
    h.commitVerifier.evidenceOnly = true;
    expect(
      (await call("submit_verdict", { handoff: h.verdictFor("verification-pass", run) })).body,
    ).toEqual({ verdict: "pass" });
    // The pass gate ran on the current HEAD, not on the implementer's.
    expect(h.testGate.calls).toHaveLength(1);
  });

  it("without a previous green gate a pass is rejected", async () => {
    const h = mcpHarness();
    const t = h.task(verifying);
    const run = insertRun(h.db, t.id, { phase: "verify" });
    const { call } = await h.connect(run.runToken);
    await call("get_task_context");
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-pass", run),
    });
    expect(result.body).toEqual({ verdict: "reject" });
    expect(runOf(h, run.id)?.handoff).toMatchObject({
      body: { verdict: "reject", mustFix: [{ source: "approver" }] },
    });
  });

  it("if the HEAD moved while the pass gate ran, it goes back to implementation", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    h.testGate.run = async () => {
      h.commitVerifier.headSha = "c".repeat(40);
      return { passed: true, output: "" };
    };
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-pass", run),
    });
    expect(result.body).toEqual({ verdict: "reject" });
    expect(h.taskOf(run.taskId)).toMatchObject({ state: "in_progress", subState: "queued" });
  });

  it("a reject does not run the gate", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    h.commitVerifier.dirty = ["src/order.ts"];
    await call("submit_verdict", { handoff: h.verdictFor("verification-reject", run) });
    expect(h.testGate.calls).toHaveLength(0);
  });

  it("a second pass while the gate runs is rejected without launching another suite", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    let release: (value: { passed: boolean; output: string }) => void = () => {};
    let started = 0;
    h.testGate.run = () => {
      started += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const handoff = h.verdictFor("verification-pass", run);
    const first = call("submit_verdict", { handoff });
    await vi.waitFor(() => expect(started).toBe(1));
    expect((await call("submit_verdict", { handoff })).body).toMatchObject({
      error: "gate_in_progress",
    });
    release({ passed: true, output: "" });
    expect((await first).body).toEqual({ verdict: "pass" });
    expect(started).toBe(1);
  });

  it("if the Run closed while the pass gate ran, it does not store the verdict", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    h.testGate.run = async () => {
      closeRun(h.db, run.id, { result: "failure", failureReason: "timeout" });
      return { passed: true, output: "" };
    };
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-pass", run),
    });
    expect(result.body).toMatchObject({ error: "invalid_run_token" });
    expect(runOf(h, run.id)).toMatchObject({ handoff: null, result: "failure" });
  });

  it("after a pass, the token can no longer ask or report a failure", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    await call("submit_verdict", { handoff: h.verdictFor("verification-pass", run) });
    for (const [tool, args] of [
      ["ask_human", { question: "¿Algo más?" }],
      ["report_failure", { reason: "me arrepentí" }],
    ] as const) {
      expect((await call(tool, args)).body).toMatchObject({ error: "tool_not_allowed" });
    }
    expect(h.taskOf(task.id)).toMatchObject(verifying);
    expect(runOf(h, run.id)).toMatchObject({ endedAt: null, result: null });
    expect((await call("get_task_context")).isError).toBe(false);
  });

  it("a verdict that does not cover all the spec's criteria is rejected", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    const handoff = h.verdictFor("verification-pass", run);
    handoff.body.criteriaVerdicts = (handoff.body.criteriaVerdicts as unknown[]).slice(0, 1);
    const result = await call("submit_verdict", { handoff });
    expect(result.body).toMatchObject({
      error: "spec_mismatch",
      issues: [{ path: "body.criteriaVerdicts", message: expect.stringContaining("AC-2") }],
    });
  });

  it("an invalid handoff is rejected with its errors", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    const handoff = h.verdictFor("verification-pass", run);
    handoff.body.riskLabel = "altísimo";
    const result = await call("submit_verdict", { handoff });
    expect(result.body).toMatchObject({
      error: "invalid_handoff",
      issues: [{ path: "body.riskLabel" }],
    });
  });

  it("at the maximum iteration a reject escalates to needs_human", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", { ...verifying, verificationIteration: 5 });
    await call("submit_verdict", { handoff: h.verdictFor("verification-reject", run) });
    expect(h.taskOf(task.id)).toMatchObject({ state: "needs_human" });
  });
});

describe("submit_verdict: reviewer evidence, cap, risk and hooks", () => {
  const verdictEvents = (h: ReturnType<typeof mcpHarness>, taskId: string) =>
    listEvents(h.db, taskId).filter((e) => e.type === "verification.verdict_recorded");

  it("rejects a reported reviewer that does not appear in the Run's hooks, without effects", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    // Only the security reviewer ran; the verdict says the code one ran too.
    h.reviewersRan(run.id, ["lunasq-security-reviewer"]);
    const result = await call("submit_verdict", {
      handoff: handoffFor("verification-reject", run),
    });

    expect(result).toMatchObject({
      isError: true,
      body: {
        error: "reviewer_evidence_mismatch",
        issues: [{ path: "body.reviewers.lunasq-code-reviewer" }],
      },
    });
    expect(h.taskOf(task.id)).toMatchObject(verifying);
    expect(runOf(h, run.id)).toMatchObject({ handoff: null, endedAt: null });
    expect(h.testGate.calls).toHaveLength(0);
    expect(h.phaseHooks.calls).toHaveLength(0);
  });

  it("rejects an omitted reviewer that did run and finish in the Run", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    h.reviewersRan(run.id, ["lunasq-ux-reviewer"]);
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-reject", run),
    });
    expect(result.body).toMatchObject({
      error: "reviewer_evidence_mismatch",
      issues: [{ path: "body.reviewers.lunasq-ux-reviewer" }],
    });
  });

  it("other Runs' hooks do not count as evidence", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    const other = insertRun(h.db, task.id, { phase: "verify", endedAt: new Date() });
    h.reviewersRan(other.id, ["lunasq-security-reviewer", "lunasq-code-reviewer"]);
    const result = await call("submit_verdict", {
      handoff: handoffFor("verification-reject", run),
    });
    expect(result.body).toMatchObject({ error: "reviewer_evidence_mismatch" });
  });

  it("a reject sets the risk label and publishes the verdict in the same step", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    await call("submit_verdict", { handoff: h.verdictFor("verification-reject", run) });
    expect(h.taskOf(task.id)).toMatchObject({ riskLabel: "medium", verificationIteration: 1 });
    expect(verdictEvents(h, task.id).map((e) => e.payload)).toEqual([
      {
        runId: run.id,
        verdict: "reject",
        iteration: 0,
        riskLabel: "medium",
        mustFix: 1,
        refuted: 0,
        skippedReviewers: ["lunasq-ux-reviewer", "lunasq-ui-reviewer"],
      },
    ]);
  });

  it("a pass sets the risk label, publishes the verdict and repeating it does not duplicate it", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    const handoff = h.verdictFor("verification-pass", run);
    await call("submit_verdict", { handoff });
    await call("submit_verdict", { handoff });
    expect(h.taskOf(task.id)).toMatchObject({ ...verifying, riskLabel: "low" });
    expect(verdictEvents(h, task.id).map((e) => e.payload)).toEqual([
      expect.objectContaining({ verdict: "pass", riskLabel: "low", refuted: 1 }),
    ]);
  });

  it("the iteration cap comes from the project's config", async () => {
    const h = mcpHarness();
    new ProjectRepository(h.db).update(h.project.id, { limits: { maxVerificationIterations: 1 } });
    const first = await h.ready("verify", verifying);
    await first.call("submit_verdict", {
      handoff: h.verdictFor("verification-reject", first.run),
    });
    expect(h.taskOf(first.task.id)).toMatchObject({
      state: "in_progress",
      verificationIteration: 1,
    });

    const second = await h.ready("verify", { ...verifying, verificationIteration: 1 });
    await second.call("submit_verdict", {
      handoff: h.verdictFor("verification-reject", second.run),
    });
    expect(h.taskOf(second.task.id)).toMatchObject({ state: "needs_human", subState: null });
  });

  it("without any cap saved, the default 5 allows five reworks and the sixth reject escalates", async () => {
    const h = mcpHarness();
    const last = await h.ready("verify", { ...verifying, verificationIteration: 4 });
    await last.call("submit_verdict", { handoff: h.verdictFor("verification-reject", last.run) });
    expect(h.taskOf(last.task.id)).toMatchObject({
      state: "in_progress",
      verificationIteration: 5,
    });

    const exhausted = await h.ready("verify", { ...verifying, verificationIteration: 5 });
    await exhausted.call("submit_verdict", {
      handoff: h.verdictFor("verification-reject", exhausted.run),
    });
    expect(h.taskOf(exhausted.task.id)).toMatchObject({ state: "needs_human", subState: null });
  });

  it("the global cap from Settings applies when the project sets none", async () => {
    const h = mcpHarness();
    new SettingsRepository(h.db).saveVerification({ maxVerificationIterations: 2 });
    const below = await h.ready("verify", { ...verifying, verificationIteration: 1 });
    await below.call("submit_verdict", { handoff: h.verdictFor("verification-reject", below.run) });
    expect(h.taskOf(below.task.id)).toMatchObject({
      state: "in_progress",
      verificationIteration: 2,
    });

    const atCap = await h.ready("verify", { ...verifying, verificationIteration: 2 });
    await atCap.call("submit_verdict", {
      handoff: h.verdictFor("verification-reject", atCap.run),
    });
    expect(h.taskOf(atCap.task.id)).toMatchObject({ state: "needs_human", subState: null });
  });

  it.each([
    { source: "global", cap: 2 },
    { source: "project", cap: 7 },
  ])(
    "after a human resume, the $source cap of $cap grants a full cycle of reworks through submit_verdict",
    async ({ source, cap }) => {
      const h = mcpHarness();
      if (source === "global") {
        new SettingsRepository(h.db).saveVerification({ maxVerificationIterations: cap });
      } else {
        new ProjectRepository(h.db).update(h.project.id, {
          limits: { maxVerificationIterations: cap },
        });
      }
      const reject = async (taskId: string) => {
        const run = insertRun(h.db, taskId, { phase: "verify", agentKind: "claude" });
        h.gated(taskId, h.commitVerifier.headSha);
        const { call } = await h.connect(run.runToken);
        const context = await call("get_task_context");
        if (context.isError) throw new Error(JSON.stringify(context.body));
        await call("submit_verdict", { handoff: h.verdictFor("verification-reject", run) });
        return h.taskOf(taskId);
      };

      // The cycle is exhausted at the effective cap.
      const first = await h.ready("verify", { ...verifying, verificationIteration: cap });
      await first.call("submit_verdict", {
        handoff: h.verdictFor("verification-reject", first.run),
      });
      const taskId = first.task.id;
      expect(h.taskOf(taskId)).toMatchObject({ state: "needs_human", verificationIteration: cap });

      // The human resumes: a new full cycle starts at the current iteration.
      const resumed = transitionTask(h.db, { taskId, actor: "human", command: { type: "resume" } });
      expect(resumed.ok).toBe(true);
      expect(h.taskOf(taskId)).toMatchObject({
        state: "in_progress",
        verificationIteration: cap,
        verificationCycleStart: cap,
      });

      for (let i = 1; i <= cap; i++) {
        setTaskPosition(h.db, taskId, { ...verifying, verificationIteration: cap + i - 1 });
        expect(await reject(taskId)).toMatchObject({
          state: "in_progress",
          verificationIteration: cap + i,
        });
      }
      setTaskPosition(h.db, taskId, { ...verifying, verificationIteration: cap * 2 });
      expect(await reject(taskId)).toMatchObject({
        state: "needs_human",
        verificationIteration: cap * 2,
      });
    },
  );

  it("the project cap overrides the global cap", async () => {
    const h = mcpHarness();
    new SettingsRepository(h.db).saveVerification({ maxVerificationIterations: 2 });
    new ProjectRepository(h.db).update(h.project.id, { limits: { maxVerificationIterations: 6 } });
    const run = await h.ready("verify", { ...verifying, verificationIteration: 3 });
    await run.call("submit_verdict", { handoff: h.verdictFor("verification-reject", run.run) });
    expect(h.taskOf(run.task.id)).toMatchObject({
      state: "in_progress",
      verificationIteration: 4,
    });
  });

  it("runs after_verification with the verdict before recording it", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    await call("submit_verdict", { handoff: h.verdictFor("verification-reject", run) });
    expect(h.phaseHooks.calls).toEqual([
      { taskId: task.id, point: "after_verification", runId: run.id, phaseResult: "reject" },
    ]);
  });

  it("after_verification runs after the pass gate", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    const order: string[] = [];
    h.testGate.run = async () => {
      order.push("gate");
      return { passed: true, output: "" };
    };
    h.phaseHooks.onRun = (input) => order.push(input.point);
    await call("submit_verdict", { handoff: h.verdictFor("verification-pass", run) });
    expect(order).toEqual(["gate", "after_verification"]);
  });

  it("after a blocked after_verification, a retry does not run hooks or the gate again", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    h.phaseHooks.results.after_verification = {
      outcome: "blocked",
      escalated: true,
      failedScript: "10-notify",
      error: null,
    };
    h.phaseHooks.onRun = () =>
      setTaskPosition(h.db, task.id, { state: "needs_human", subState: null });
    const handoff = h.verdictFor("verification-pass", run);
    expect((await call("submit_verdict", { handoff })).body).toMatchObject({
      error: "hook_blocked",
    });
    expect((await call("submit_verdict", { handoff })).body).toMatchObject({
      error: "transition_rejected",
    });
    expect(h.phaseHooks.calls).toHaveLength(1);
    expect(h.testGate.calls).toHaveLength(1);
  });

  it("a blocked after_verification does not record the verdict", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    h.phaseHooks.results.after_verification = {
      outcome: "blocked",
      escalated: true,
      failedScript: "10-notify",
      error: null,
    };
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-reject", run),
    });
    expect(result.body).toMatchObject({
      error: "hook_blocked",
      message: expect.stringContaining("10-notify"),
    });
    expect(runOf(h, run.id)).toMatchObject({ handoff: null, endedAt: null });
    expect(verdictEvents(h, task.id)).toEqual([]);
    expect(h.taskOf(task.id)?.riskLabel).toBeNull();
  });
});

describe("report_failure", () => {
  it("closes the Run as failed and the task goes back to queued with the attempt counted", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    const result = await call("report_failure", { reason: "la base no compila" });
    expect(result).toEqual({ isError: false, body: { attempt: 1 } });
    expect(runOf(h, run.id)).toMatchObject({
      result: "failure",
      failureReason: "la base no compila",
    });
    expect(h.taskOf(task.id)).toMatchObject({ state: "in_progress", subState: "queued" });
    // The closed Run's token no longer works.
    expect((await call("get_task_context")).body.error).toBe("invalid_run_token");
  });

  it("the third failed retry escalates to needs_human", async () => {
    const h = mcpHarness();
    const task = h.task(implementing);
    for (const at of [1000, 2000, 3000]) {
      const failed = insertRun(h.db, task.id, { startedAt: new Date(at) });
      closeRun(h.db, failed.id, { result: "failure", failureReason: "x" });
    }
    const run = insertRun(h.db, task.id);
    const { call } = await h.connect(run.runToken);
    await call("get_task_context");
    const result = await call("report_failure", { reason: "otra vez" });
    expect(result.body).toEqual({ attempt: 4 });
    expect(h.taskOf(task.id)).toMatchObject({ state: "needs_human" });
  });
});

describe("run_reviewer: verifiable CLI executions", () => {
  it("launches the Copilot profile and persists the prompt, answer and execution state", async () => {
    const reviewer = {
      run: vi.fn(async () => ({
        transcriptPath: "/lunasq/copilot-reviewers/run/copilot-session.jsonl",
        output: "NO FINDINGS",
      })),
    };
    const h = mcpHarness({ copilotReviewers: reviewer });
    const { task, run, call } = await h.ready("verify", verifying, { agentKind: "copilot" });
    const result = await call("run_reviewer", {
      reviewer: "lunasq-security-reviewer",
      instructions: "Revisa AC-1 y el diff de src/auth.ts",
    });

    expect(result).toEqual({ isError: false, body: { output: "NO FINDINGS" } });
    expect(reviewer.run).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: task.worktreePath,
        reviewer: "lunasq-security-reviewer",
        instructions: "Revisa AC-1 y el diff de src/auth.ts",
      }),
    );
    const [evidence] = new RunSubagentRepository(h.db).forRun(run.id);
    expect(evidence).toMatchObject({
      agentType: "lunasq-security-reviewer",
      agentId: expect.stringMatching(/^copilot-/),
      transcriptPath: "/lunasq/copilot-reviewers/run/copilot-session.jsonl",
    });
    expect(evidence?.startedAt).toBeInstanceOf(Date);
    expect(evidence?.stoppedAt).toBeInstanceOf(Date);
  });

  it("does not let Claude declare reviewer evidence by itself", async () => {
    const reviewer = { run: vi.fn() };
    const h = mcpHarness({ copilotReviewers: reviewer });
    const { run, call } = await h.ready("verify", verifying);
    const result = await call("run_reviewer", {
      reviewer: "lunasq-code-reviewer",
      instructions: "Revisa el diff",
    });
    expect(result.body).toMatchObject({ error: "reviewer_execution_unavailable" });
    expect(reviewer.run).not.toHaveBeenCalled();
    expect(new RunSubagentRepository(h.db).forRun(run.id)).toEqual([]);
  });

  it("launches Codex reviewers and records their transcript under the Codex agent id", async () => {
    const reviewer = {
      run: vi.fn(async () => ({
        transcriptPath: "/lunasq/codex-reviewers/run/codex-session.jsonl",
        output: "NO FINDINGS",
      })),
    };
    const h = mcpHarness({ codexReviewers: reviewer });
    const { task, run, call } = await h.ready("verify", verifying, { agentKind: "codex" });
    const result = await call("run_reviewer", {
      reviewer: "lunasq-security-reviewer",
      instructions: "Review AC-1 and src/auth.ts",
    });

    expect(result).toEqual({ isError: false, body: { output: "NO FINDINGS" } });
    expect(reviewer.run).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: task.worktreePath,
        reviewer: "lunasq-security-reviewer",
        instructions: "Review AC-1 and src/auth.ts",
      }),
    );
    expect(new RunSubagentRepository(h.db).forRun(run.id)).toMatchObject([
      {
        agentType: "lunasq-security-reviewer",
        agentId: expect.stringMatching(/^codex-/),
        transcriptPath: "/lunasq/codex-reviewers/run/codex-session.jsonl",
      },
    ]);
  });

  it("a Copilot failure stays as an attempt without SubagentStop and cannot count as ran", async () => {
    const reviewer = { run: vi.fn(async () => Promise.reject(new Error("auth required"))) };
    const h = mcpHarness({ copilotReviewers: reviewer });
    const { run, call } = await h.ready("verify", verifying, { agentKind: "copilot" });
    const result = await call("run_reviewer", {
      reviewer: "lunasq-code-reviewer",
      instructions: "Revisa el diff",
    });
    expect(result.body).toMatchObject({
      error: "reviewer_execution_failed",
      message: "auth required",
    });
    expect(new RunSubagentRepository(h.db).forRun(run.id)).toMatchObject([
      { agentType: "lunasq-code-reviewer", stoppedAt: null, transcriptPath: null },
    ]);
  });
});
