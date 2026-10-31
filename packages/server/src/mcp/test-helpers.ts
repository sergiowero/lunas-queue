// Arnés de los tests de contrato del LunasQ MCP: el cliente oficial de MCP habla con la app de
// Hono en memoria, con el gate de tests y la comprobación de commits falsos.
import { readFileSync } from "node:fs";
import {
  appendEvent,
  type LunasqDatabase,
  RunSubagentRepository,
  SpecRepository,
  TaskRepository,
} from "@lunasq/db";
import {
  insertProject,
  insertRun,
  insertTask,
  migratedDatabase,
  setTaskPosition,
} from "@lunasq/db/test-helpers";
import { type Phase, type StatePosition, TEST_GATE_EXECUTED } from "@lunasq/schemas";
import type { CopilotReviewerExecutor } from "./copilot-reviewer.ts";

type Position = StatePosition & { verificationIteration?: number };

import { specContentExample } from "@lunasq/schemas/testing";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach } from "vitest";
import { createApp } from "../app.ts";
import type {
  CommitCheckInput,
  CommitVerifier,
  PhaseHookInput,
  PhaseHookResult,
  PhaseHooks,
  TestGate,
  TestGateInput,
  TestGateResult,
} from "./ports.ts";
import { RUN_TOKEN_HEADER } from "./routes.ts";

const examples = new URL("../../../schemas/examples/handoff/v1/valid/", import.meta.url);

type Example = "refinement" | "implementation" | "verification-pass" | "verification-reject";

/** Handoff válido de ejemplo con los ids del Run que lo envía. */
export function handoffFor(
  example: Example,
  run: { id: string; taskId: string },
): Record<string, unknown> & { body: Record<string, unknown> } {
  const handoff = JSON.parse(readFileSync(new URL(`${example}.json`, examples), "utf8"));
  return { ...handoff, taskId: run.taskId, runId: run.id };
}

export class FakeTestGate implements TestGate {
  readonly calls: TestGateInput[] = [];
  result: TestGateResult = { passed: true, output: "todo en verde" };

  async run(input: TestGateInput): Promise<TestGateResult> {
    this.calls.push(input);
    return this.result;
  }
}

/** Hooks de fase falsos: registran cada punto y devuelven el resultado configurado por punto. */
export class FakePhaseHooks implements PhaseHooks {
  readonly calls: PhaseHookInput[] = [];
  results: Partial<Record<PhaseHookInput["point"], PhaseHookResult>> = {};
  /** Se llama antes de devolver el resultado: simula un hook que commitea o tarda. */
  onRun: ((input: PhaseHookInput) => void) | null = null;

  async run(input: PhaseHookInput): Promise<PhaseHookResult> {
    this.calls.push(input);
    this.onRun?.(input);
    return (
      this.results[input.point] ?? {
        outcome: "passed",
        escalated: false,
        failedScript: null,
        error: null,
      }
    );
  }
}

export class FakeCommitVerifier implements CommitVerifier {
  readonly calls: CommitCheckInput[] = [];
  absent = new Set<string>();

  async missing(input: CommitCheckInput): Promise<string[]> {
    this.calls.push(input);
    return input.commits.filter((sha) => this.absent.has(sha));
  }

  dirty: string[] = [];

  async uncommitted(_worktreePath: string): Promise<string[]> {
    return this.dirty;
  }

  headSha: string | null = "a".repeat(40);

  async head(_worktreePath: string): Promise<string | null> {
    return this.headSha;
  }

  /** Respuesta de `onlyEvidenceBetween`: true simula commits intermedios de solo evidencia. */
  evidenceOnly = false;

  async onlyEvidenceBetween(_input: {
    worktreePath: string;
    from: string;
    to: string;
  }): Promise<boolean> {
    return this.evidenceOnly;
  }
}

export type CallResult = { isError: boolean; body: Record<string, unknown> };

const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

export interface McpHarnessOptions {
  /** Gate real en vez del fake; recibe la base del arnés. */
  testGate?: (db: LunasqDatabase) => TestGate;
  testCommand?: string;
  worktreePath?: string;
  copilotReviewers?: CopilotReviewerExecutor;
}

export function mcpHarness(options: McpHarnessOptions = {}) {
  const db = migratedDatabase();
  const project = insertProject(db, {
    testCommand: options.testCommand ?? "pnpm test",
    baseBranch: "main",
  });
  const testGate = new FakeTestGate();
  const commitVerifier = new FakeCommitVerifier();
  const phaseHooks = new FakePhaseHooks();
  const app = createApp({
    db,
    testGate: options.testGate?.(db) ?? testGate,
    commitVerifier,
    phaseHooks,
    ...(options.copilotReviewers && { copilotReviewers: options.copilotReviewers }),
  });

  async function connect(token?: string) {
    const client = new Client({ name: "lunasq-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      // Un fetch real manda Host; la validación contra DNS rebinding lo exige.
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("host", new URL(url).host);
        return app.fetch(new Request(url, { ...init, headers }));
      },
      ...(token === undefined ? {} : { requestInit: { headers: { [RUN_TOKEN_HEADER]: token } } }),
    });
    await client.connect(transport);
    clients.push(client);
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallResult> => {
      const result = await client.callTool({ name, arguments: args });
      const [first] = result.content as { type: string; text: string }[];
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(first?.text ?? "{}");
      } catch {
        body = { text: first?.text };
      }
      return { isError: result.isError === true, body };
    };
    return { client, call };
  }

  /** Tarea con worktree en el estado pedido; con `approved` su spec de ejemplo queda aprobada. */
  function task(position: Position, opts: { approved?: boolean } = {}) {
    const row = insertTask(db, project.id, {
      state: "draft",
      subState: "running",
      worktreePath: options.worktreePath ?? "/wt/tarea",
      branch: "lunasq/tarea",
    });
    if (opts.approved ?? true) {
      const specs = new SpecRepository(db);
      const submitted = specs.submit(row.id, specContentExample());
      if (!submitted.ok) throw new Error(submitted.error.message);
      const approved = specs.approve(row.id, submitted.spec.version);
      if (!approved.ok) throw new Error(approved.error.message);
    }
    setTaskPosition(db, row.id, position);
    return row;
  }

  /** Run activo de la fase con su sesión MCP; `ready` ya llamó get_task_context. */
  async function session(
    phase: Phase,
    position: Position,
    opts: { approved?: boolean; agentKind?: "claude" | "copilot" } = {},
  ) {
    const t = task(position, opts);
    const run = insertRun(db, t.id, { phase, agentKind: opts.agentKind ?? "claude" });
    // En verificación, la tarea llega con el gate de submit_for_verification en verde en su HEAD.
    if (phase === "verify") gated(t.id, commitVerifier.headSha);
    const { call } = await connect(run.runToken);
    return { task: t, run, call };
  }

  /** Registra un gate en verde de submit_for_verification sobre `headSha`. */
  function gated(taskId: string, headSha: string | null) {
    appendEvent(db, {
      taskId,
      type: TEST_GATE_EXECUTED,
      actor: "system",
      payload: {
        runId: "run-implementacion",
        trigger: "submit_for_verification",
        command: "pnpm test",
        headSha,
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        passed: true,
        output: "",
        error: null,
      },
    });
  }

  async function ready(
    phase: Phase,
    position: Position,
    opts: { approved?: boolean; agentKind?: "claude" | "copilot" } = {},
  ) {
    const s = await session(phase, position, opts);
    const context = await s.call("get_task_context");
    if (context.isError) throw new Error(JSON.stringify(context.body));
    return s;
  }

  const taskOf = (taskId: string) => new TaskRepository(db).get(taskId);

  const subagents = new RunSubagentRepository(db);
  /** Registra, como los hooks SubagentStart y SubagentStop, una ejecución terminada por revisor. */
  function reviewersRan(runId: string, names: readonly string[]) {
    for (const name of names) {
      const ref = { agentId: `${name}-${runId}`, agentType: name };
      subagents.recordStart(runId, ref);
      subagents.recordStop(runId, ref);
    }
  }

  /** Veredicto de ejemplo con los revisores que reporta `ran` registrados en los hooks del Run. */
  function verdictFor(
    example: "verification-pass" | "verification-reject",
    run: { id: string; taskId: string },
  ) {
    const handoff = handoffFor(example, run);
    const reviewers = handoff.body.reviewers as Record<string, { status: string }>;
    reviewersRan(
      run.id,
      Object.keys(reviewers).filter((name) => reviewers[name]?.status === "ran"),
    );
    return handoff;
  }

  return {
    db,
    project,
    app,
    testGate,
    commitVerifier,
    phaseHooks,
    connect,
    task,
    session,
    ready,
    gated,
    taskOf,
    reviewersRan,
    verdictFor,
  };
}
