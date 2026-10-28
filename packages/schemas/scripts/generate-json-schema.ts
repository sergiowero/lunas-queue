// Regenera json-schema/v1 desde los esquemas Zod. El test de drift falla si se olvida correrlo.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHandoffJsonSchemas } from "../src/handoff/json-schema.ts";

const outDir = join(import.meta.dirname, "../json-schema/v1");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const [file, schema] of Object.entries(buildHandoffJsonSchemas())) {
  writeFileSync(join(outDir, file), `${JSON.stringify(schema, null, 2)}\n`);
}
