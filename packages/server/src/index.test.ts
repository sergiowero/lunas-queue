import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@lunasq/server", () => {
  it("exporta su nombre de paquete", () => {
    expect(packageName).toBe("@lunasq/server");
  });
});
