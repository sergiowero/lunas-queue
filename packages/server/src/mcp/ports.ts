// Puertos del LunasQ MCP hacia el worktree: el gate de tests, la comprobación de commits y los
// hooks de fase. El gate corre en un pane de herdr y deja su resultado en el Event log
// (test-gate/, UW-11); la comprobación de commits corre comandos de git con el ProcessRunner de
// adapters; los hooks los corre HookService (hooks/, UW-10).
import type { ProcessRunner } from "@lunasq/adapters";
import type { HookPoint, HookPointOutcome, TestGateTrigger } from "@lunasq/schemas";

export type TestGateInput = {
  taskId: string;
  runId: string;
  worktreePath: string;
  /** Comando de tests del proyecto; sin él no hay gate en verde. */
  command: string | null;
  /** Qué pidió el gate; queda en el evento `test_gate.executed`. */
  trigger: TestGateTrigger;
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
  /** Archivos con cambios sin commitear: el gate debe correr sobre lo commiteado. */
  uncommitted(worktreePath: string): Promise<string[]>;
  /** Sha del HEAD del worktree; null si no se puede leer. */
  head(worktreePath: string): Promise<string | null>;
}

export type PhaseHookInput = {
  taskId: string;
  point: HookPoint;
  runId: string;
  /** Resultado de la fase para los hooks `after_*` (p. ej. el veredicto). */
  phaseResult?: string | null;
};

export type PhaseHookResult = {
  outcome: HookPointOutcome;
  /** La tarea pasó a needs_human con `hook_failed`. */
  escalated: boolean;
  failedScript: string | null;
  error: string | null;
};

/** Hooks de un punto de fase; HookService lo cumple. */
export interface PhaseHooks {
  run(input: PhaseHookInput): Promise<PhaseHookResult>;
}

/** Sin hooks compuestos: cada punto pasa sin correr nada, como un proyecto sin `lunasq/hooks/`. */
export class NoPhaseHooks implements PhaseHooks {
  async run(_input: PhaseHookInput): Promise<PhaseHookResult> {
    return { outcome: "passed", escalated: false, failedScript: null, error: null };
  }
}

export const GATE_OUTPUT_LIMIT = 4000;

/** Tiempo límite por defecto del gate: una suite colgada no debe correr para siempre. */
export const DEFAULT_GATE_TIMEOUT_MS = 20 * 60_000;

/** El final de la salida, que es donde está el error. */
export const tailOf = (text: string, limit: number) =>
  text.length > limit ? text.slice(text.length - limit) : text;

/** Comillas de shell POSIX: el valor llega como un solo argumento literal. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export class GitCommitVerifier implements CommitVerifier {
  readonly #runner: ProcessRunner;

  constructor(runner: ProcessRunner) {
    this.#runner = runner;
  }

  async missing(input: CommitCheckInput): Promise<string[]> {
    const missing: string[] = [];
    for (const sha of input.commits) {
      // El SHA ya viene validado como hexadecimal por el esquema del handoff; --end-of-options
      // evita que una rama base como `--foo` se lea como opción de git. El worktree sale de
      // origin/<base> (ADR 0012) y la base local puede ir atrasada: un commit que ya está en
      // cualquiera de las dos no es de la tarea.
      const remote = `origin/${input.baseBranch}`;
      const result = await this.#runner.run({
        command: [
          `git rev-parse --verify --quiet --end-of-options ${quote(`${input.baseBranch}^{commit}`)} >/dev/null`,
          `git merge-base --is-ancestor --end-of-options ${quote(sha)} HEAD`,
          `! git merge-base --is-ancestor --end-of-options ${quote(sha)} ${quote(input.baseBranch)}`,
          `{ ! git rev-parse --verify --quiet --end-of-options ${quote(`${remote}^{commit}`)} >/dev/null || ! git merge-base --is-ancestor --end-of-options ${quote(sha)} ${quote(remote)}; }`,
        ].join(" && "),
        cwd: input.worktreePath,
      });
      if (result.exitCode !== 0) missing.push(sha);
    }
    return missing;
  }

  async head(worktreePath: string): Promise<string | null> {
    const result = await this.#runner.run({
      command: "git rev-parse --verify --quiet HEAD^{commit}",
      cwd: worktreePath,
    });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async uncommitted(worktreePath: string): Promise<string[]> {
    const result = await this.#runner.run({
      command: "git status --porcelain --untracked-files=all",
      cwd: worktreePath,
    });
    if (result.exitCode !== 0) return ["(git status falló)"];
    return result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(3));
  }
}
