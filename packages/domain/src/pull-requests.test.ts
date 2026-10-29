import { describe, expect, it } from "vitest";
import { prStateChange } from "./pull-requests.ts";

describe("prStateChange", () => {
  it("un PR abierto avanza a merged o closed", () => {
    expect(prStateChange("open", "merged")).toBe("merged");
    expect(prStateChange("open", "closed")).toBe("closed");
  });

  it("sin cambio o sin PR registrado no hay transición", () => {
    expect(prStateChange("open", "open")).toBeNull();
    expect(prStateChange(null, "merged")).toBeNull();
  });

  it("un dato viejo nunca revierte un merge ni un cierre", () => {
    expect(prStateChange("merged", "open")).toBeNull();
    expect(prStateChange("merged", "closed")).toBeNull();
    expect(prStateChange("closed", "open")).toBeNull();
    expect(prStateChange("closed", "merged")).toBeNull();
  });
});
