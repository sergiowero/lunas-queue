import { describe, expect, it } from "vitest";
import { effectiveAgentKind, enabledFallbackOrder } from "./providers.ts";

const all = { claude: true, copilot: true, codex: true };

describe("effective provider", () => {
  it("with all providers enabled it is the primary", () => {
    expect(effectiveAgentKind("claude", all)).toBe("claude");
    expect(effectiveAgentKind("copilot", all)).toBe("copilot");
    expect(effectiveAgentKind("codex", all)).toBe("codex");
  });

  it("with the primary disabled it is the first enabled one of the fallback", () => {
    expect(effectiveAgentKind("claude", { claude: false, copilot: true, codex: true })).toBe(
      "copilot",
    );
    expect(effectiveAgentKind("copilot", { claude: true, copilot: false, codex: true })).toBe(
      "claude",
    );
    expect(effectiveAgentKind("codex", { claude: true, copilot: true, codex: false })).toBe(
      "claude",
    );
  });

  it("with all disabled there is no effective provider", () => {
    expect(
      effectiveAgentKind("claude", { claude: false, copilot: false, codex: false }),
    ).toBeNull();
  });
});

describe("enabled fallback order", () => {
  it("it starts with the primary and continues with the others in registration order", () => {
    expect(enabledFallbackOrder("claude", all)).toEqual(["claude", "copilot", "codex"]);
    expect(enabledFallbackOrder("copilot", all)).toEqual(["copilot", "claude", "codex"]);
    expect(enabledFallbackOrder("codex", all)).toEqual(["codex", "claude", "copilot"]);
  });

  it("filters out the disabled ones, also the primary", () => {
    expect(enabledFallbackOrder("claude", { claude: false, copilot: true, codex: false })).toEqual([
      "copilot",
    ]);
    expect(enabledFallbackOrder("claude", { claude: true, copilot: false, codex: false })).toEqual([
      "claude",
    ]);
    expect(
      enabledFallbackOrder("copilot", { claude: false, copilot: false, codex: false }),
    ).toEqual([]);
  });
});
