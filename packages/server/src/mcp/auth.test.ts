// Guardas comunes del LunasQ MCP: run token, fase del Run y gate de get_task_context.
import { closeRun, listEvents, RunRepository } from "@lunasq/db";
import { insertRun } from "@lunasq/db/test-helpers";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES, TOOL_PHASES } from "./service.ts";
import { handoffFor, mcpHarness } from "./test-helpers.ts";

const running = { state: "in_progress", subState: "running" } as const;

describe("LunasQ MCP: transporte", () => {
  it("lista las 8 tools con su inputSchema", async () => {
    const h = mcpHarness();
    const { client } = await h.connect("cualquiera");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const checklist = tools.find((t) => t.name === "update_checklist");
    expect(checklist?.inputSchema).toMatchObject({ type: "object", required: ["items"] });
  });

  it("rechaza un Host que no es localhost (DNS rebinding)", async () => {
    const h = mcpHarness();
    const res = await h.app.request("http://evil.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("LunasQ MCP: run token", () => {
  // Argumentos válidos por tool: así la llamada llega a la guarda y no la frena el inputSchema.
  const validArgs = (run: {
    id: string;
    taskId: string;
  }): Record<string, Record<string, unknown>> => ({
    get_task_context: {},
    submit_spec: { handoff: handoffFor("refinement", run) },
    ask_human: { question: "¿Sigo?" },
    update_checklist: { items: [{ taskId: "T-1", done: true }] },
    submit_for_verification: { handoff: handoffFor("implementation", run) },
    run_reviewer: {
      reviewer: "lunasq-code-reviewer",
      instructions: "revisa el diff",
    },
    submit_verdict: { handoff: handoffFor("verification-reject", run) },
    report_failure: { reason: "no puedo" },
  });

  it.each(TOOL_NAMES)("%s con el token de un Run cerrado se rechaza sin efectos", async (tool) => {
    const h = mcpHarness();
    const task = h.task(running);
    const old = insertRun(h.db, task.id, {
      phase: TOOL_PHASES[tool][0] ?? "implement",
      contextReadAt: new Date(),
      endedAt: new Date(),
      result: "failure",
    });
    const before = listEvents(h.db, task.id).length;
    for (const token of [old.runToken, undefined]) {
      const { call } = await h.connect(token);
      const result = await call(tool, validArgs(old)[tool]);
      expect(result).toMatchObject({ isError: true, body: { error: "invalid_run_token" } });
    }
    expect(listEvents(h.db, task.id)).toHaveLength(before);
    expect(h.taskOf(task.id)).toMatchObject(running);
    expect(new RunRepository(h.db).get(old.id)).toMatchObject({ result: "failure", handoff: null });
    expect(h.testGate.calls).toHaveLength(0);
  });

  it("sin header, con token desconocido o de un Run cerrado: invalid_run_token", async () => {
    const h = mcpHarness();
    const task = h.task(running);
    const old = insertRun(h.db, task.id, { endedAt: new Date(), result: "failure" });
    insertRun(h.db, task.id);
    for (const token of [undefined, "desconocido", old.runToken]) {
      const { call } = await h.connect(token);
      const result = await call("get_task_context");
      expect(result).toMatchObject({ isError: true, body: { error: "invalid_run_token" } });
    }
  });

  it("una sesión vieja no mueve la tarea aunque mande un handoff válido", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.ready("implement", running);
    // El dispatcher cierra el Run y abre otro: el token de la sesión anterior queda viejo.
    closeRun(h.db, run.id, { result: "failure", failureReason: "timeout" });
    insertRun(h.db, task.id);
    const result = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });
    expect(result).toMatchObject({ isError: true, body: { error: "invalid_run_token" } });
    expect(h.taskOf(task.id)).toMatchObject(running);
    expect(h.testGate.calls).toHaveLength(0);
  });
});

describe("LunasQ MCP: fase y contexto", () => {
  it("una tool de otra fase se rechaza con tool_not_allowed", async () => {
    const h = mcpHarness();
    const { run, call } = await h.ready("implement", running);
    const result = await call("submit_spec", { handoff: handoffFor("refinement", run) });
    expect(result).toMatchObject({ isError: true, body: { error: "tool_not_allowed" } });
  });

  it("las tools de salida exigen get_task_context antes", async () => {
    const h = mcpHarness();
    const { task, run, call } = await h.session("implement", running);
    const before = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });
    expect(before).toMatchObject({ isError: true, body: { error: "context_required" } });
    for (const [tool, args] of [
      ["ask_human", { question: "¿?" }],
      ["update_checklist", { items: [{ taskId: "T-1", done: true }] }],
      ["report_failure", { reason: "x" }],
    ] as const) {
      expect((await call(tool, args)).body.error).toBe("context_required");
    }
    expect(h.taskOf(task.id)).toMatchObject(running);

    expect((await call("get_task_context")).isError).toBe(false);
    expect(new RunRepository(h.db).get(run.id)?.contextReadAt).toBeInstanceOf(Date);
    const after = await call("submit_for_verification", {
      handoff: handoffFor("implementation", run),
    });
    expect(after.isError).toBe(false);
  });

  it("run_reviewer requiere contexto antes de lanzar un perfil", async () => {
    const h = mcpHarness({
      copilotReviewers: {
        run: async () => {
          throw new Error("no ejecutar");
        },
      },
    });
    const { call } = await h.session(
      "verify",
      { state: "verification", subState: "running" },
      { agentKind: "copilot" },
    );
    const result = await call("run_reviewer", {
      reviewer: "lunasq-code-reviewer",
      instructions: "revisa el diff",
    });
    expect(result.body).toEqual({ error: "context_required", message: expect.any(String) });
  });
});
