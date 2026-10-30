// Tests de contrato de cada tool del LunasQ MCP, por el cliente oficial de MCP.
import {
  closeRun,
  createQuestion,
  listEvents,
  ProjectRepository,
  RunRepository,
  SpecRepository,
} from "@lunasq/db";
import { insertRun, setTaskPosition } from "@lunasq/db/test-helpers";
import { specContentExample } from "@lunasq/schemas/testing";
import { describe, expect, it, vi } from "vitest";
import { handoffFor, mcpHarness } from "./test-helpers.ts";

const refining = { state: "draft", subState: "running" } as const;
const implementing = { state: "in_progress", subState: "running" } as const;
const verifying = { state: "verification", subState: "running" } as const;

const runOf = (h: ReturnType<typeof mcpHarness>, id: string) => new RunRepository(h.db).get(id);

describe("get_task_context", () => {
  it("implementación recibe intent, proyecto, spec aprobada y checklist", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.session("implement", implementing);
    const { isError, body } = await call("get_task_context");
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      task: { id: task.id, intent: task.intent, state: "in_progress", worktreePath: "/wt/tarea" },
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

  it("refinamiento tras cambios pedidos recibe la versión y sus comentarios", async () => {
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

  it("verificación recibe el handoff de implementación, el historial y el intento previo", async () => {
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

  it("tras un reject, implementación recibe solo los must-fix y no el historial", async () => {
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

  it("sin reject previo, o con un pass como último veredicto, no hay rework", async () => {
    const h = mcpHarness();
    const task = h.task(implementing);
    const verify1 = insertRun(h.db, task.id, { phase: "verify", startedAt: new Date(1000) });
    closeRun(h.db, verify1.id, {
      result: "success",
      handoff: handoffFor("verification-pass", verify1),
    });
    // Un conflicto en la entrega devuelve a implementación sin rework del verificador.
    const run = insertRun(h.db, task.id, { phase: "implement" });
    const { call } = await h.connect(run.runToken);
    expect((await call("get_task_context")).body).toMatchObject({ rework: null });
  });

  it("verificación no recibe rework", async () => {
    const h = mcpHarness();
    const { call } = await h.session("verify", verifying);
    expect((await call("get_task_context")).body).toMatchObject({ rework: null });
  });

  it("repetirla no mueve la marca de lectura", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("implement", implementing);
    const first = runOf(h, run.id)?.contextReadAt?.getTime();
    await call("get_task_context");
    expect(runOf(h, run.id)?.contextReadAt?.getTime()).toBe(first);
  });
});

describe("submit_spec", () => {
  it("crea la versión, pasa la tarea a refined y cierra el Run con el handoff", async () => {
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

  it("un handoff inválido se rechaza con errores por ruta y no escribe nada", async () => {
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
    // El agente corrige y reintenta en el mismo Run.
    expect((await call("submit_spec", { handoff: handoffFor("refinement", run) })).isError).toBe(
      false,
    );
  });

  it("un handoff de otra fase, tarea o Run se rechaza con handoff_mismatch", async () => {
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

  it("si la máquina de estados rechaza, no queda versión ni Run cerrado", async () => {
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

describe("ask_human", () => {
  it("registra la Question, pasa a waiting_human y regresa de inmediato", async () => {
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
        status: "open",
        answer: null,
      },
    ]);
    expect(runOf(h, run.id)?.endedAt).toBeNull();
  });

  it("con la tarea ya esperando al humano se rechaza sin crear otra Question", async () => {
    const h = mcpHarness();
    const { task, call } = await h.ready("implement", implementing);
    await call("ask_human", { question: "¿Uno?" });
    const again = await call("ask_human", { question: "¿Dos?" });
    expect(again.body).toMatchObject({ error: "transition_rejected" });
    expect(listEvents(h.db, task.id).filter((e) => e.type === "question.created")).toHaveLength(1);
  });

  it("valida la entrada", async () => {
    const h = mcpHarness();
    const { call } = await h.ready("implement", implementing);
    expect((await call("ask_human", { question: "" })).isError).toBe(true);
  });
});

describe("update_checklist", () => {
  it("marca items de la task list aprobada y devuelve el checklist completo", async () => {
    const h = mcpHarness();
    const { task, call } = await h.ready("implement", implementing);
    const result = await call("update_checklist", { items: [{ taskId: "T-1", done: true }] });
    const checklist = [{ taskId: "T-1", title: "Comando CancelOrder en el agregado", done: true }];
    expect(result).toEqual({ isError: false, body: { checklist } });
    expect((await call("get_task_context")).body.checklist).toEqual(checklist);

    // Repetir la misma marca no agrega otro evento.
    await call("update_checklist", { items: [{ taskId: "T-1", done: true }] });
    expect(listEvents(h.db, task.id).filter((e) => e.type === "checklist.updated")).toHaveLength(1);
  });

  it("rechaza items que no están en la spec aprobada", async () => {
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
  it("con gate en verde y commits del branch pasa a verification y cierra el Run", async () => {
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

  it("corre after_implementation y before_verification antes del gate", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    const order: string[] = [];
    h.testGate.run = async (input) => {
      order.push(`gate:${h.commitVerifier.headSha}`);
      return { passed: input.command !== null, output: "" };
    };
    // Un hook que commitea mueve el HEAD: el gate corre sobre el commit nuevo.
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

  it("un hook bloqueado detiene la llamada antes del gate y no transiciona", async () => {
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

  it("una suite en rojo bloquea la transición aunque el agente diga lo contrario", async () => {
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

  it("criterios sin tests o ajenos a la spec se rechazan antes de correr el gate", async () => {
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

  it("commits que no están en el branch de la tarea se rechazan", async () => {
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

  it("un handoff inválido se rechaza con sus errores", async () => {
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

  it("si el dispatcher cerró el Run y abrió otro mientras corría el gate, no transiciona", async () => {
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

  it("un worktree con cambios sin commitear se rechaza antes del gate", async () => {
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

  it("un segundo submit mientras corre el gate se rechaza sin lanzar otra suite", async () => {
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

  it("si la tarea cambió mientras corría el gate, no transiciona", async () => {
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
  it("reject vuelve a in_progress con iteración + 1 y cierra el Run", async () => {
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

  it("pass guarda el veredicto con el Run abierto y no transiciona: la entrega emite el pass", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    const handoff = h.verdictFor("verification-pass", run);
    expect(await call("submit_verdict", { handoff })).toEqual({
      isError: false,
      body: { verdict: "pass" },
    });
    expect(h.taskOf(task.id)).toMatchObject(verifying);
    expect(runOf(h, run.id)).toMatchObject({ handoff, endedAt: null });

    // Repetir el mismo veredicto es idempotente y no vuelve a correr el gate; uno distinto se rechaza.
    expect((await call("submit_verdict", { handoff })).isError).toBe(false);
    expect(h.testGate.calls).toHaveLength(1);
    const reject = await call("submit_verdict", {
      handoff: h.verdictFor("verification-reject", run),
    });
    expect(reject.body).toMatchObject({ error: "verdict_already_recorded" });
    expect(h.taskOf(task.id)).toMatchObject(verifying);
  });

  it("antes de aceptar un pass, LunasQ corre el gate de tests en el worktree", async () => {
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

  it("un pass con la suite en rojo se rechaza aunque el verificador diga lo contrario", async () => {
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

    // El Run sigue abierto: el verificador puede corregir su veredicto a reject. Los 4 revisores
    // ya corrieron en este Run, así que el reject los reporta a todos.
    const reject = h.verdictFor("verification-reject", run);
    const ran = { status: "ran", findings: [] };
    reject.body.reviewers = {
      ...(reject.body.reviewers as object),
      "lunasq-ux-reviewer": ran,
      "lunasq-ui-reviewer": ran,
    };
    expect((await call("submit_verdict", { handoff: reject })).body).toEqual({ verdict: "reject" });
  });

  it("un pass con el worktree sucio se rechaza antes del gate", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    h.commitVerifier.dirty = ["src/order.ts"];
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-pass", run),
    });
    expect(result.body).toMatchObject({
      error: "dirty_worktree",
      issues: [{ path: "src/order.ts" }],
    });
    expect(h.testGate.calls).toHaveLength(0);
    expect(runOf(h, run.id)?.handoff).toBeNull();
  });

  it("un pass sobre un HEAD distinto del que pasó el gate de submit_for_verification se rechaza", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    // El verificador commiteó algo propio, p. ej. borrar los tests en rojo.
    h.commitVerifier.headSha = "b".repeat(40);
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-pass", run),
    });
    expect(result.body).toMatchObject({ error: "head_changed" });
    expect(h.testGate.calls).toHaveLength(0);
    expect(runOf(h, run.id)?.handoff).toBeNull();

    // Vale el último gate en verde: tras un rework, el HEAD nuevo.
    h.gated(run.taskId, "b".repeat(40));
    expect(
      (await call("submit_verdict", { handoff: h.verdictFor("verification-pass", run) })).body,
    ).toEqual({ verdict: "pass" });
  });

  it("sin gate en verde previo un pass se rechaza", async () => {
    const h = mcpHarness();
    const t = h.task(verifying);
    const run = insertRun(h.db, t.id, { phase: "verify" });
    const { call } = await h.connect(run.runToken);
    await call("get_task_context");
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-pass", run),
    });
    expect(result.body).toMatchObject({ error: "head_changed" });
  });

  it("si el HEAD se movió mientras corría el gate del pass, se rechaza", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    h.testGate.run = async () => {
      h.commitVerifier.headSha = "c".repeat(40);
      return { passed: true, output: "" };
    };
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-pass", run),
    });
    expect(result.body).toMatchObject({ error: "head_changed" });
    expect(runOf(h, run.id)?.handoff).toBeNull();
  });

  it("un reject no corre el gate", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("verify", verifying);
    h.commitVerifier.dirty = ["src/order.ts"];
    await call("submit_verdict", { handoff: h.verdictFor("verification-reject", run) });
    expect(h.testGate.calls).toHaveLength(0);
  });

  it("un segundo pass mientras corre el gate se rechaza sin lanzar otra suite", async () => {
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

  it("si el Run se cerró mientras corría el gate del pass, no guarda el veredicto", async () => {
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

  it("tras un pass, el token ya no puede preguntar ni reportar fallo", async () => {
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

  it("un veredicto que no cubre todos los criterios de la spec se rechaza", async () => {
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

  it("un handoff inválido se rechaza con sus errores", async () => {
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

  it("en la iteración máxima un reject escala a needs_human", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", { ...verifying, verificationIteration: 3 });
    await call("submit_verdict", { handoff: h.verdictFor("verification-reject", run) });
    expect(h.taskOf(task.id)).toMatchObject({ state: "needs_human" });
  });
});

describe("submit_verdict: evidencia de revisores, tope, riesgo y hooks (UW-23)", () => {
  const verdictEvents = (h: ReturnType<typeof mcpHarness>, taskId: string) =>
    listEvents(h.db, taskId).filter((e) => e.type === "verification.verdict_recorded");

  it("rechaza un revisor reportado que no aparece en los hooks del Run, sin efectos", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    // Solo corrió el revisor de seguridad; el veredicto dice que corrió también el de código.
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

  it("rechaza un revisor omitido que sí corrió y terminó en el Run", async () => {
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

  it("los hooks de otro Run no cuentan como evidencia", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    const other = insertRun(h.db, task.id, { phase: "verify", endedAt: new Date() });
    h.reviewersRan(other.id, ["lunasq-security-reviewer", "lunasq-code-reviewer"]);
    const result = await call("submit_verdict", {
      handoff: handoffFor("verification-reject", run),
    });
    expect(result.body).toMatchObject({ error: "reviewer_evidence_mismatch" });
  });

  it("un reject fija la etiqueta de riesgo y publica el veredicto en el mismo paso", async () => {
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

  it("un pass fija la etiqueta de riesgo, publica el veredicto y repetirlo no lo duplica", async () => {
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

  it("el tope de iteraciones sale de la config del proyecto", async () => {
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

  it("corre after_verification con el veredicto antes de registrarlo", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("verify", verifying);
    await call("submit_verdict", { handoff: h.verdictFor("verification-reject", run) });
    expect(h.phaseHooks.calls).toEqual([
      { taskId: task.id, point: "after_verification", runId: run.id, phaseResult: "reject" },
    ]);
  });

  it("after_verification corre después del gate del pass", async () => {
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

  it("un after_verification bloqueado no registra el veredicto", async () => {
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
  it("cierra el Run como fallido y la tarea vuelve a queued con el intento contado", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", implementing);
    const result = await call("report_failure", { reason: "la base no compila" });
    expect(result).toEqual({ isError: false, body: { attempt: 1 } });
    expect(runOf(h, run.id)).toMatchObject({
      result: "failure",
      failureReason: "la base no compila",
    });
    expect(h.taskOf(task.id)).toMatchObject({ state: "in_progress", subState: "queued" });
    // El token del Run cerrado ya no sirve.
    expect((await call("get_task_context")).body.error).toBe("invalid_run_token");
  });

  it("el tercer reintento fallido escala a needs_human", async () => {
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
