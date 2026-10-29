// Gate de tests (docs/design.md §Prácticas de ingeniería, ADR uw-11-gate-tests). LunasQ corre el
// comando de tests del proyecto en un pane de herdr abierto desde el worktree de la tarea, sin
// credenciales del entorno, y deja cada ejecución en el Event log con `test_gate.executed`. Lo que
// el agente diga de sus tests no cuenta: solo el exit code de esta ejecución.
import {
  type GitAdapter,
  type HerdrAdapter,
  HerdrPaneRunner,
  type ProcessResult,
  type ProcessRunner,
} from "@lunasq/adapters";
import { appendEvent, type LunasqDatabase } from "@lunasq/db";
import {
  TEST_GATE_EXECUTED,
  TEST_GATE_OUTPUT_LIMIT,
  TestGateExecutedPayload,
} from "@lunasq/schemas";
import {
  DEFAULT_GATE_TIMEOUT_MS,
  GATE_OUTPUT_LIMIT,
  type TestGate,
  type TestGateInput,
  type TestGateResult,
  tailOf,
} from "../mcp/ports.ts";
import type { EnsuredWorktree } from "../worktrees/service.ts";

/**
 * Variables del pane que llegan a la suite; el resto (`GH_TOKEN`, claves de API) no. Lo justo
 * para encontrar las herramientas y escribir en el home y el tmpdir.
 */
export const GATE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
];

export interface PaneTestGateDeps {
  db: LunasqDatabase;
  git: Pick<GitAdapter, "resolveCommit">;
  /** Asegura el worktree de la tarea (WorktreeService.ensure); el pane se abre desde su raíz. */
  worktrees: { ensure(taskId: string): Promise<EnsuredWorktree> };
  /** Por defecto, HerdrPaneRunner sobre `herdr`. */
  runnerFor?: (parentPaneId: string) => ProcessRunner;
  herdr?: HerdrAdapter;
  timeoutMs?: number;
}

type Execution = {
  headSha: string | null;
  result: ProcessResult | null;
  error: string | null;
  durationMs: number;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class PaneTestGate implements TestGate {
  private readonly db: LunasqDatabase;
  private readonly git: Pick<GitAdapter, "resolveCommit">;
  private readonly worktrees: PaneTestGateDeps["worktrees"];
  private readonly runnerFor: (parentPaneId: string) => ProcessRunner;
  private readonly timeoutMs: number;

  constructor(deps: PaneTestGateDeps) {
    this.db = deps.db;
    this.git = deps.git;
    this.worktrees = deps.worktrees;
    const herdr = deps.herdr;
    this.runnerFor =
      deps.runnerFor ??
      ((parentPaneId) => {
        if (!herdr) throw new Error("PaneTestGate necesita herdr o runnerFor");
        return new HerdrPaneRunner({ herdr, parentPaneId });
      });
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  }

  async run(input: TestGateInput): Promise<TestGateResult> {
    // Un comando vacío cuenta como sin comando.
    const command = input.command?.trim() ? input.command : null;
    const execution = command
      ? await this.execute(input, command)
      : {
          headSha: null,
          result: null,
          error: "el proyecto no tiene comando de tests configurado",
          durationMs: 0,
        };
    const { result, error } = execution;
    const passed = error === null && result !== null && result.exitCode === 0 && !result.timedOut;
    const output = result ? `${result.stdout}${result.stderr}` : "";

    appendEvent(
      this.db,
      {
        taskId: input.taskId,
        type: TEST_GATE_EXECUTED,
        actor: "system",
        payload: TestGateExecutedPayload.parse({
          runId: input.runId,
          trigger: input.trigger,
          command,
          headSha: execution.headSha,
          exitCode: result?.exitCode ?? null,
          timedOut: result?.timedOut ?? false,
          durationMs: execution.durationMs,
          passed,
          output: tailOf(output, TEST_GATE_OUTPUT_LIMIT),
          error: error && tailOf(error, 2000),
        }),
      },
      { publish: true },
    );

    // Al agente le llega la cola de la salida y, al final, por qué no hubo resultado.
    const notes = [result?.timedOut ? "el gate de tests excedió su tiempo límite" : null, error];
    const shown = notes.reduce<string>(
      (text, note) =>
        note === null ? text : `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${note}\n`,
      output,
    );
    return { passed, output: tailOf(shown, GATE_OUTPUT_LIMIT) };
  }

  private async execute(input: TestGateInput, command: string): Promise<Execution> {
    const started = Date.now();
    // El sha es evidencia, no condición: si no se puede leer, la suite corre igual.
    const headSha = await this.git
      .resolveCommit({ cwd: input.worktreePath, ref: "HEAD" })
      .catch(() => null);
    try {
      // ensure es idempotente: con el worktree ya listo solo devuelve su pane raíz.
      const worktree = await this.worktrees.ensure(input.taskId);
      if (worktree.path !== input.worktreePath) {
        throw new Error(`el worktree de la tarea es ${worktree.path}, no ${input.worktreePath}`);
      }
      const { rootPaneId } = worktree;
      const result = await this.runnerFor(rootPaneId).run({
        command,
        cwd: input.worktreePath,
        env: { CI: "1", LUNASQ_TASK_ID: input.taskId, LUNASQ_RUN_ID: input.runId },
        envAllowlist: GATE_ENV_ALLOWLIST,
        timeoutMs: this.timeoutMs,
      });
      return { headSha, result, error: null, durationMs: Date.now() - started };
    } catch (err) {
      return {
        headSha,
        result: null,
        error: `no se pudo correr el gate de tests: ${message(err)}`,
        durationMs: Date.now() - started,
      };
    }
  }
}

/** Gate de un servidor armado sin herdr (p. ej. solo la API): ninguna verificación pasa. */
export class UnavailableTestGate implements TestGate {
  async run(_input: TestGateInput): Promise<TestGateResult> {
    return { passed: false, output: "el gate de tests no está disponible en este servidor" };
  }
}
