import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHandoffJsonSchemas } from "./json-schema.ts";

const outDir = join(import.meta.dirname, "../../json-schema/v1");

describe("handoff v1 JSON Schema", () => {
  const generated = buildHandoffJsonSchemas();

  it("generates the full handoff and one per phase", () => {
    expect(Object.keys(generated).sort()).toEqual([
      "handoff.json",
      "implementation.json",
      "refinement.json",
      "result.json",
      "verification.json",
    ]);
  });

  it("the versioned JSON Schema in the repo matches the Zod schemas", () => {
    const committed = readdirSync(outDir).filter((file) => file.endsWith(".json"));
    expect(committed.sort(), "corre `pnpm --filter @lunasq/schemas generate`").toEqual(
      Object.keys(generated).sort(),
    );
    for (const [file, schema] of Object.entries(generated)) {
      const onDisk = JSON.parse(readFileSync(join(outDir, file), "utf8"));
      expect(onDisk, `${file} out of date: run generate`).toEqual(schema);
    }
  });

  it("keeps the defaulted deliverable optional in the input JSON Schema", () => {
    const refinementProperties = generated["refinement.json"]?.properties as
      | {
          body?: { properties?: Record<string, { default?: unknown }>; required?: string[] };
        }
      | undefined;
    const body = refinementProperties?.body;

    expect(body?.properties?.deliverable?.default).toBe("code");
    expect(body?.required).not.toContain("deliverable");
  });

  it("each schema declares draft 2020-12 and a versioned $id", () => {
    for (const [file, schema] of Object.entries(generated)) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.$id).toBe(`urn:lunasq:handoff:v1:${file.replace(".json", "")}`);
    }
  });
});
