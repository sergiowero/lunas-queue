import { z } from "zod";
import { ImplementationHandoff } from "./implementation.ts";
import { HANDOFF_MAX_BYTES, HandoffV1 } from "./index.ts";
import { RefinementHandoff } from "./refinement.ts";
import { VerificationHandoff } from "./verification.ts";

export type JsonSchema = Record<string, unknown> & { $schema: string; $id: string };

const schemas = {
  "handoff.json": HandoffV1,
  "refinement.json": RefinementHandoff,
  "implementation.json": ImplementationHandoff,
  "verification.json": VerificationHandoff,
};

// El JSON Schema describe la estructura; las reglas entre campos solo viven en Zod.
const description =
  "Handoff v1 de LunasQ, generado desde @lunasq/schemas. Las reglas entre campos (ids únicos, " +
  `veredicto coherente, tamaño máximo de ${HANDOFF_MAX_BYTES} bytes) las aplica el validador Zod.`;

export function buildHandoffJsonSchemas(): Record<string, JsonSchema> {
  return Object.fromEntries(
    Object.entries(schemas).map(([file, schema]) => {
      const { $schema, ...rest } = z.toJSONSchema(schema);
      const $id = `urn:lunasq:handoff:v1:${file.replace(".json", "")}`;
      return [file, { $schema: $schema ?? "", $id, description, ...rest }];
    }),
  );
}
