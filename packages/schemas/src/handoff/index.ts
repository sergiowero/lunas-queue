import { z } from "zod";
import { type HandoffError, ROOT_PATH, toHandoffErrors } from "./errors.ts";
import { ImplementationHandoff } from "./implementation.ts";
import { RefinementHandoff } from "./refinement.ts";
import { VerificationHandoff } from "./verification.ts";

export * from "./envelope.ts";
export type { HandoffError } from "./errors.ts";
export * from "./implementation.ts";
export * from "./refinement.ts";
export * from "./verification.ts";

export const HandoffV1 = z.discriminatedUnion(
  "phase",
  [RefinementHandoff, ImplementationHandoff, VerificationHandoff],
  {
    error: (issue) =>
      issue.code === "invalid_union"
        ? "fase desconocida: se esperaba refinement, implementation o verification"
        : undefined,
  },
);
export type HandoffV1 = z.infer<typeof HandoffV1>;

// Un cambio de esquema agrega una versión aquí; las anteriores se siguen leyendo.
export const handoffSchemas = { 1: HandoffV1 } as const;
export type HandoffVersion = keyof typeof handoffSchemas;
export type Handoff = HandoffV1;
export const CURRENT_HANDOFF_VERSION = 1 satisfies HandoffVersion;

export const HANDOFF_MAX_BYTES = 32 * 1024;

export type ParseHandoffResult =
  | { success: true; data: Handoff }
  | { success: false; errors: HandoffError[] };

const spanish = z.locales.es().localeError;

export function parseHandoff(input: unknown): ParseHandoffResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return failure(ROOT_PATH, "el handoff debe ser un objeto JSON");
  }
  const version = (input as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== "number" || !Object.hasOwn(handoffSchemas, version)) {
    const supported = Object.keys(handoffSchemas).join(", ");
    return failure(
      "schemaVersion",
      `versión de esquema no soportada: ${String(version)}; versiones soportadas: ${supported}`,
    );
  }
  const bytes = utf8Length(JSON.stringify(input));
  if (bytes > HANDOFF_MAX_BYTES) {
    return failure(
      ROOT_PATH,
      `el handoff mide ${bytes} bytes y el máximo es ${HANDOFF_MAX_BYTES} bytes; el detalle va en el repo`,
    );
  }
  const result = handoffSchemas[version as HandoffVersion].safeParse(input, { error: spanish });
  return result.success
    ? { success: true, data: result.data }
    : { success: false, errors: toHandoffErrors(result.error) };
}

function failure(path: string, message: string): ParseHandoffResult {
  return { success: false, errors: [{ path, message }] };
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
