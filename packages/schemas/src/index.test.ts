import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@lunasq/schemas", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@lunasq/schemas");
  });
});
