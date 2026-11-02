import { describe, expect, it } from "vitest";
import { effectiveAgentKind, enabledFallbackOrder } from "./providers.ts";

const both = { claude: true, copilot: true };

describe("effective provider", () => {
  it("with both enabled it is the primary", () => {
    expect(effectiveAgentKind("claude", both)).toBe("claude");
    expect(effectiveAgentKind("copilot", both)).toBe("copilot");
  });

  it("with the primary disabled it is the first enabled one of the fallback", () => {
    expect(effectiveAgentKind("claude", { claude: false, copilot: true })).toBe("copilot");
    expect(effectiveAgentKind("copilot", { claude: true, copilot: false })).toBe("claude");
  });

  it("with all disabled there is no effective provider", () => {
    expect(effectiveAgentKind("claude", { claude: false, copilot: false })).toBeNull();
  });
});

describe("enabled fallback order", () => {
  it("it starts with the primary and continues with the others in registration order", () => {
    expect(enabledFallbackOrder("claude", both)).toEqual(["claude", "copilot"]);
    expect(enabledFallbackOrder("copilot", both)).toEqual(["copilot", "claude"]);
  });

  it("filters out the disabled ones, also the primary", () => {
    expect(enabledFallbackOrder("claude", { claude: false, copilot: true })).toEqual(["copilot"]);
    expect(enabledFallbackOrder("claude", { claude: true, copilot: false })).toEqual(["claude"]);
    expect(enabledFallbackOrder("copilot", { claude: false, copilot: false })).toEqual([]);
  });
});
