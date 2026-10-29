// Fake del runner de procesos: registra las llamadas y responde con un handler; por defecto, éxito.
import type { ProcessInput, ProcessResult, ProcessRunner } from "./types.ts";

export type FakeProcessHandler = (
  input: ProcessInput,
) => Partial<ProcessResult> | Promise<Partial<ProcessResult>>;

export class FakeProcessRunner implements ProcessRunner {
  readonly calls: ProcessInput[] = [];

  private handler: FakeProcessHandler;

  constructor(handler: FakeProcessHandler = () => ({})) {
    this.handler = handler;
  }

  /** Cambia la respuesta de las llamadas siguientes. */
  respond(handler: FakeProcessHandler) {
    this.handler = handler;
  }

  async run(input: ProcessInput): Promise<ProcessResult> {
    this.calls.push(structuredClone(input));
    const res = await this.handler(input);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...res };
  }
}
