// Ejecución de comandos de proyecto (bootstrap del worktree; después el gate de tests y los hooks).
// El resto del sistema depende solo de esta interfaz; ShellProcessRunner y FakeProcessRunner la cumplen.

export interface ProcessInput {
  /** Línea de shell; se corre con `sh -c`. */
  command: string;
  cwd: string;
  /** Se suma al env del proceso de LunasQ. */
  env?: Record<string, string>;
  /** Sin límite si se omite. */
  timeoutMs?: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessRunner {
  /** No lanza por un exit code distinto de 0: quien llama decide qué es un fallo. */
  run(input: ProcessInput): Promise<ProcessResult>;
}
