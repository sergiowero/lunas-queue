import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHandoffJsonSchemas } from "./json-schema.ts";

const outDir = join(import.meta.dirname, "../../json-schema/v1");

describe("JSON Schema de handoff v1", () => {
  const generated = buildHandoffJsonSchemas();

  it("genera el handoff completo y uno por fase", () => {
    expect(Object.keys(generated).sort()).toEqual([
      "handoff.json",
      "implementation.json",
      "refinement.json",
      "verification.json",
    ]);
  });

  it("el JSON Schema versionado en el repo coincide con los esquemas Zod", () => {
    const committed = readdirSync(outDir).filter((file) => file.endsWith(".json"));
    expect(committed.sort(), "corre `pnpm --filter @lunasq/schemas generate`").toEqual(
      Object.keys(generated).sort(),
    );
    for (const [file, schema] of Object.entries(generated)) {
      const onDisk = JSON.parse(readFileSync(join(outDir, file), "utf8"));
      expect(onDisk, `${file} desactualizado: corre el generate`).toEqual(schema);
    }
  });

  it("cada esquema declara draft 2020-12 y un $id versionado", () => {
    for (const [file, schema] of Object.entries(generated)) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.$id).toBe(`urn:lunasq:handoff:v1:${file.replace(".json", "")}`);
    }
  });
});
