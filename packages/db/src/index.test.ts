import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@lunasq/db", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@lunasq/db");
  });
});
