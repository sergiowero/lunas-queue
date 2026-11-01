import { describe, expect, it } from "vitest";
import { formatAgent, formatTimeout } from "./format.ts";

describe("formatTimeout", () => {
  it("muestra el timeout configurado sin redondearlo", () => {
    expect(formatTimeout(30)).toBe("30 s");
    expect(formatTimeout(90)).toBe("90 s");
    expect(formatTimeout(150)).toBe("150 s");
    expect(formatTimeout(300)).toBe("5 min");
    expect(formatTimeout(600)).toBe("10 min");
  });
});

describe("formatAgent", () => {
  it("une agentKind y modelo con un punto medio", () => {
    expect(formatAgent({ agentKind: "claude", model: "opus" })).toBe("claude · opus");
  });

  it("muestra solo el agentKind cuando no hay modelo", () => {
    expect(formatAgent({ agentKind: "claude", model: null })).toBe("claude");
  });
});
