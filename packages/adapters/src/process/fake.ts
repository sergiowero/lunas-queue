// Fake of the process runner: records the calls and answers with a handler; by default, success.
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

  /** Changes the response of the following calls. */
  respond(handler: FakeProcessHandler) {
    this.handler = handler;
  }

  async run(input: ProcessInput): Promise<ProcessResult> {
    this.calls.push(structuredClone(input));
    const res = await this.handler(input);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...res };
  }
}
