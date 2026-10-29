// Puertos del LunasQ MCP hacia el worktree: el gate de tests y la comprobación de commits. Las
// implementaciones de aquí corren comandos con el ProcessRunner de adapters; UW-11 reemplaza el
// gate por la ejecución en un pane de herdr con su registro de salida.
import type { ProcessRunner } from "@lunasq/adapters";

export type TestGateInput = {
  taskId: string;
  runId: string;
  worktreePath: string;
  /** Comando de tests del proyecto; sin él no hay gate en verde. */
  command: string | null;
};

export type TestGateResult = {
  passed: boolean;
  /** Cola de la salida combinada, para que el agente sepa qué corregir. */
  output: string;
};

export interface TestGate {
  run(input: TestGateInput): Promise<TestGateResult>;
}

export type CommitCheckInput = {
  worktreePath: string;
  baseBranch: string;
  commits: string[];
};

export interface CommitVerifier {
  /** Commits del handoff que no están en el branch de la tarea (o que ya están en la base). */
  missing(input: CommitCheckInput): Promise<string[]>;
}

export const GATE_OUTPUT_LIMIT = 4000;

const tail = (text: string) =>
  text.length > GATE_OUTPUT_LIMIT ? text.slice(text.length - GATE_OUTPUT_LIMIT) : text;

/** Comillas de shell POSIX: el valor llega como un solo argumento literal. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export class ShellTestGate implements TestGate {
  readonly #runner: ProcessRunner;
  readonly #timeoutMs: number | undefined;

  constructor(runner: ProcessRunner, opts: { timeoutMs?: number } = {}) {
    this.#runner = runner;
    this.#timeoutMs = opts.timeoutMs;
  }

  async run(input: TestGateInput): Promise<TestGateResult> {
    if (!input.command) {
      return { passed: false, output: "el proyecto no tiene comando de tests configurado" };
    }
    const result = await this.#runner.run({
      command: input.command,
      cwd: input.worktreePath,
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
    });
    const output = tail(`${result.stdout}${result.stderr}`);
    if (result.timedOut) {
      return { passed: false, output: `${output}\nel gate de tests excedió su tiempo límite` };
    }
    return { passed: result.exitCode === 0, output };
  }
}

export class GitCommitVerifier implements CommitVerifier {
  readonly #runner: ProcessRunner;

  constructor(runner: ProcessRunner) {
    this.#runner = runner;
  }

  async missing(input: CommitCheckInput): Promise<string[]> {
    const missing: string[] = [];
    for (const sha of input.commits) {
      // El SHA ya viene validado como hexadecimal por el esquema del handoff.
      const result = await this.#runner.run({
        command: [
          `git rev-parse --verify --quiet ${quote(`${input.baseBranch}^{commit}`)} >/dev/null`,
          `git merge-base --is-ancestor ${quote(sha)} HEAD`,
          `! git merge-base --is-ancestor ${quote(sha)} ${quote(input.baseBranch)}`,
        ].join(" && "),
        cwd: input.worktreePath,
      });
      if (result.exitCode !== 0) missing.push(sha);
    }
    return missing;
  }
}
