import { z } from "zod";
import { ImplementationHandoff } from "./implementation.ts";
import { HANDOFF_MAX_BYTES, HandoffV1 } from "./index.ts";
import { RefinementHandoff } from "./refinement.ts";
import { ResultHandoff } from "./result.ts";
import { VerificationHandoff } from "./verification.ts";

export type JsonSchema = Record<string, unknown> & { $schema: string; $id: string };

const schemas = {
  "handoff.json": HandoffV1,
  "refinement.json": RefinementHandoff,
  "implementation.json": ImplementationHandoff,
  "verification.json": VerificationHandoff,
  // Handoff of submit_result: it has its own envelope, outside handoff.json.
  "result.json": ResultHandoff,
};

// The JSON Schema describes the structure; the cross-field rules only live in Zod.
const description =
  "LunasQ handoff v1, generated from @lunasq/schemas. The cross-field rules (unique ids, " +
  `coherent verdict, maximum size of ${HANDOFF_MAX_BYTES} bytes) are applied by the Zod validator.`;

export function buildHandoffJsonSchemas(): Record<string, JsonSchema> {
  return Object.fromEntries(
    Object.entries(schemas).map(([file, schema]) => {
      const { $schema, ...rest } = z.toJSONSchema(schema, { io: "input" });
      const $id = `urn:lunasq:handoff:v1:${file.replace(".json", "")}`;
      return [file, { $schema: $schema ?? "", $id, description, ...rest }];
    }),
  );
}
