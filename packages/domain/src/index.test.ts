import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@lunasq/domain", () => {
  it("exporta su nombre de paquete", () => {
    expect(packageName).toBe("@lunasq/domain");
  });
});
