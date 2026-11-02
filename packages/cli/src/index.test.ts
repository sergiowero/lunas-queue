import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@lunasq/cli", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@lunasq/cli");
  });
});
