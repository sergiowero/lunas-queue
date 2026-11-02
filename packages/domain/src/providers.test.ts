import { describe, expect, it } from "vitest";
import { effectiveAgentKind, enabledFallbackOrder } from "./providers.ts";

const both = { claude: true, copilot: true };

describe("proveedor efectivo", () => {
  it("con ambos habilitados es el primario", () => {
    expect(effectiveAgentKind("claude", both)).toBe("claude");
    expect(effectiveAgentKind("copilot", both)).toBe("copilot");
  });

  it("con el primario deshabilitado es el primer habilitado del fallback", () => {
    expect(effectiveAgentKind("claude", { claude: false, copilot: true })).toBe("copilot");
    expect(effectiveAgentKind("copilot", { claude: true, copilot: false })).toBe("claude");
  });

  it("con todos deshabilitados no hay proveedor efectivo", () => {
    expect(effectiveAgentKind("claude", { claude: false, copilot: false })).toBeNull();
  });
});

describe("orden de fallback habilitado", () => {
  it("empieza por el primario y sigue con los demás en orden de registro", () => {
    expect(enabledFallbackOrder("claude", both)).toEqual(["claude", "copilot"]);
    expect(enabledFallbackOrder("copilot", both)).toEqual(["copilot", "claude"]);
  });

  it("filtra los deshabilitados, también el primario", () => {
    expect(enabledFallbackOrder("claude", { claude: false, copilot: true })).toEqual(["copilot"]);
    expect(enabledFallbackOrder("claude", { claude: true, copilot: false })).toEqual(["claude"]);
    expect(enabledFallbackOrder("copilot", { claude: false, copilot: false })).toEqual([]);
  });
});
