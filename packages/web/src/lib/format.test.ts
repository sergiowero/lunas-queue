import { describe, expect, it } from "vitest";
import { es } from "./dictionary/es.ts";
import { BOARD_STATES, canPause, canResume, formatAgent, formatTimeout } from "./format.ts";

describe("formatTimeout", () => {
  it("shows the configured timeout without rounding it", () => {
    expect(formatTimeout(30)).toBe("30 s");
    expect(formatTimeout(90)).toBe("90 s");
    expect(formatTimeout(150)).toBe("150 s");
    expect(formatTimeout(300)).toBe("5 min");
    expect(formatTimeout(600)).toBe("10 min");
  });
});

describe("formatAgent", () => {
  it("joins agentKind and model with a middle dot", () => {
    expect(formatAgent({ agentKind: "claude", model: "opus" })).toBe("claude · opus");
  });

  it("shows only the agentKind when there is no model", () => {
    expect(formatAgent({ agentKind: "claude", model: null })).toBe("claude");
  });
});

describe("pausa", () => {
  it("Paused has a label and its board column", () => {
    expect(es.state.paused).toBe("Paused");
    expect(BOARD_STATES).toContain("paused");
  });

  it("se pausan draft, refined, in_progress y verification", () => {
    expect((["draft", "refined", "in_progress", "verification"] as const).every(canPause)).toBe(
      true,
    );
    for (const state of ["completed", "cancelled", "needs_human", "paused"] as const) {
      expect(canPause(state)).toBe(false);
    }
  });

  it("paused and needs_human are resumed", () => {
    expect(canResume("paused")).toBe(true);
    expect(canResume("needs_human")).toBe(true);
    for (const state of ["draft", "refined", "in_progress", "completed"] as const) {
      expect(canResume(state)).toBe(false);
    }
  });
});
