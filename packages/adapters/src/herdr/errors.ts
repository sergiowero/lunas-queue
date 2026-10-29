/** Error de herdr con su `code` del protocolo (p. ej. `agent_not_found`, `timeout`). */
export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`herdr ${code}: ${message}`);
    this.name = "HerdrError";
    this.code = code;
  }
}

export function isHerdrError(err: unknown, code?: string): err is HerdrError {
  return err instanceof HerdrError && (code === undefined || err.code === code);
}
