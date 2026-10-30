// Loop implementación ↔ verificación de punta a punta (UW-23): scheduler, dispatcher contra herdr
// fake, LunasQ MCP por el cliente oficial y hooks de subagentes por HTTP. Los agentes son el test:
// con el run token de cada Run llaman las tools como lo haría Claude Code en el pane.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr, FakeProcessRunner } from "@lunasq/adapters";
import {
  appendEvent,
  type LunasqDatabase,
  listEvents,
  RunRepository,
  type RunRow,
  SpecRepository,
  TaskRepository,
} from "@lunasq/db";
import {
  insertProject,
  insertTask,
  migratedDatabase,
  setTaskPosition,
} from "@lunasq/db/test-helpers";
import { REVIEWER_NAMES, TEST_GATE_EXECUTED, VERDICT_RECORDED } from "@lunasq/schemas";
import { specContentExample } from "@lunasq/schemas/testing";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { Orchestrator } from "../dispatcher/orchestrator.ts";
import { OutboxPublisher } from "../outbox/publisher.ts";
import { SUBAGENT_HOOK_PATH } from "../subagents/routes.ts";
import type { TestGate, TestGateInput, TestGateResult } from "./ports.ts";
import { RUN_TOKEN_HEADER } from "./routes.ts";
import { FakeCommitVerifier, FakePhaseHooks, handoffFor } from "./test-helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const HEAD = "a".repeat(40);

/** Gate en verde que deja su `test_gate.executed`, como PaneTestGate. */
class RecordingGate implements TestGate {
  readonly #db: LunasqDatabase;
  readonly #order: string[];

  constructor(db: LunasqDatabase, order: string[]) {
    this.#db = db;
    this.#order = order;
  }

  async run(input: TestGateInput): Promise<TestGateResult> {
    this.#order.push(`gate:${input.trigger}`);
    appendEvent(
      this.#db,
      {
        taskId: input.taskId,
        type: TEST_GATE_EXECUTED,
        actor: "system",
        payload: {
          runId: input.runId,
          trigger: input.trigger,
          command: input.command,
          headSha: HEAD,
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          passed: true,
          output: "",
          error: null,
        },
      },
      { publish: true },
    );
    return { passed: true, output: "" };
  }
}

async function loop() {
  const db = migratedDatabase();
  const dir = mkdtempSync(join(tmpdir(), "lunasq-loop-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const herdr = new FakeHerdr({ promptDurationMs: 2 ** 31 - 1 });
  const publisher = new OutboxPublisher({ db, pollIntervalMs: 5 });
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
    config: { tickIntervalMs: 60_000 },
  });
  // Orden de hooks de fase y gates a lo largo del loop.
  const order: string[] = [];
  const phaseHooks = new FakePhaseHooks();
  phaseHooks.onRun = (input) => order.push(input.point);
  const app = createApp({
    db,
    testGate: new RecordingGate(db, order),
    commitVerifier: new FakeCommitVerifier(),
    phaseHooks,
  });

  const project = insertProject(db, { testCommand: "pnpm test", baseBranch: "main" });
  const task = insertTask(db, project.id, { state: "draft", subState: "running" });
  const specs = new SpecRepository(db);
  const submitted = specs.submit(task.id, specContentExample());
  if (!submitted.ok) throw new Error(submitted.error.message);
  specs.approve(task.id, submitted.spec.version);
  // Spec aprobada: la tarea entra a implementación.
  setTaskPosition(db, task.id, { state: "in_progress", subState: "queued" });

  await orchestrator.start();
  await publisher.start();
  cleanups.push(() => orchestrator.stop());
  cleanups.push(() => publisher.stop());

  const runs = new RunRepository(db);
  const tasks = new TaskRepository(db);

  /** Espera el n-ésimo Run lanzado de la fase y devuelve sus tools. */
  async function agent(phase: "implement" | "verify", n: number) {
    let run: RunRow | undefined;
    await vi.waitFor(
      () => {
        run = runs.forTask(task.id).filter((r) => r.phase === phase)[n - 1];
        expect(run?.launchedAt).toBeInstanceOf(Date);
      },
      // Cada despacho pasa por outbox, scheduler y dispatcher reales: holgura para CI cargado.
      { timeout: 15_000 },
    );
    if (!run) throw new Error("sin Run");
    const active = run;
    const client = new Client({ name: "agente", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers);
          headers.set("host", new URL(url).host);
          return app.fetch(new Request(url, { ...init, headers }));
        },
        requestInit: { headers: { [RUN_TOKEN_HEADER]: active.runToken } },
      }),
    );
    cleanups.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const [first] = result.content as { text: string }[];
      return { isError: result.isError === true, body: JSON.parse(first?.text ?? "{}") };
    };
    const context = await call("get_task_context");
    expect(context.isError).toBe(false);
    return { run: active, call, context: context.body };
  }

  /** SubagentStart y SubagentStop de cada revisor, como los manda Claude Code. */
  async function launchReviewers(run: RunRow, names: readonly string[]) {
    for (const name of names) {
      for (const hook_event_name of ["SubagentStart", "SubagentStop"]) {
        const res = await app.request(SUBAGENT_HOOK_PATH, {
          method: "POST",
          headers: { "content-type": "application/json", [RUN_TOKEN_HEADER]: run.runToken },
          body: JSON.stringify({
            hook_event_name,
            session_id: run.agentSession,
            agent_id: `${name}-${run.id}`,
            agent_type: name,
          }),
        });
        expect(res.status).toBe(200);
      }
    }
  }

  async function implement(n: number) {
    const impl = await agent("implement", n);
    const result = await impl.call("submit_for_verification", {
      handoff: handoffFor("implementation", impl.run),
    });
    expect(result).toEqual({ isError: false, body: { state: "verification" } });
    return impl;
  }

  async function verify(n: number, verdict: "pass" | "reject") {
    const verifier = await agent("verify", n);
    const handoff = handoffFor(`verification-${verdict}`, verifier.run);
    const reviewers = handoff.body.reviewers as Record<string, { status: string }>;
    await launchReviewers(
      verifier.run,
      REVIEWER_NAMES.filter((name) => reviewers[name]?.status === "ran"),
    );
    const result = await verifier.call("submit_verdict", { handoff });
    expect(result).toEqual({ isError: false, body: { verdict } });
    return { ...verifier, handoff };
  }

  const verdicts = () =>
    listEvents(db, task.id)
      .filter((e) => e.type === VERDICT_RECORDED)
      .map((e) => e.payload as { verdict: string; iteration: number });

  return { db, task, runs, tasks, implement, verify, agent, verdicts, order };
}

describe("loop implementación ↔ verificación", { timeout: 60_000 }, () => {
  it("caso pass: implementación, verificación en Sonnet con 4 revisores y veredicto pass", async () => {
    const l = await loop();
    await l.implement(1);
    const { run } = await l.verify(1, "pass");

    expect(run.model).toBe("sonnet");
    expect(l.tasks.get(l.task.id)).toMatchObject({
      state: "verification",
      subState: "running",
      verificationIteration: 0,
      riskLabel: "low",
    });
    // El Run del approver sigue abierto para la entrega (UW-26), que arranca con este evento.
    expect(l.runs.get(run.id)).toMatchObject({ endedAt: null });
    expect(l.verdicts()).toEqual([expect.objectContaining({ verdict: "pass", iteration: 0 })]);
    expect(l.order).toEqual([
      "after_implementation",
      "before_verification",
      "gate:submit_for_verification",
      "gate:verdict_pass",
      "after_verification",
    ]);
  });

  it("caso reject: vuelve a implementación con los must-fix y el segundo ciclo pasa", async () => {
    const l = await loop();
    await l.implement(1);
    const rejected = await l.verify(1, "reject");

    // Rework: un implementador nuevo recibe solo los must-fix del reject.
    const second = await l.agent("implement", 2);
    expect(second.run.iteration).toBe(1);
    expect(second.context).toMatchObject({
      verificationHistory: [],
      rework: { runId: rejected.run.id, mustFix: rejected.handoff.body.mustFix },
    });
    const result = await second.call("submit_for_verification", {
      handoff: handoffFor("implementation", second.run),
    });
    expect(result.isError).toBe(false);

    // El segundo verificador ve el historial completo y aprueba.
    const passed = await l.verify(2, "pass");
    expect(passed.context).toMatchObject({
      verificationHistory: [{ runId: rejected.run.id, body: { verdict: "reject" } }],
    });
    expect(l.tasks.get(l.task.id)).toMatchObject({
      state: "verification",
      verificationIteration: 1,
      riskLabel: "low",
    });
    expect(l.verdicts().map((v) => [v.verdict, v.iteration])).toEqual([
      ["reject", 0],
      ["pass", 1],
    ]);
  });

  it("la cuarta verificación que rechaza termina en needs_human", async () => {
    const l = await loop();
    for (let n = 1; n <= 3; n += 1) {
      await l.implement(n);
      await l.verify(n, "reject");
    }
    await l.implement(4);
    await l.verify(4, "reject");

    expect(l.tasks.get(l.task.id)).toMatchObject({
      state: "needs_human",
      subState: null,
      verificationIteration: 3,
    });
    const escalation = listEvents(l.db, l.task.id)
      .filter((e) => e.type === "task.transitioned")
      .at(-1);
    expect(escalation?.payload).toMatchObject({
      command: "verdict_rework",
      to: { state: "needs_human" },
      reason: "iterations_exhausted",
    });
    // No se despacha un quinto implementador.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(l.runs.forTask(l.task.id).filter((r) => r.phase === "implement")).toHaveLength(4);
  });
});
