import { describe, expect, it } from "vitest";
import { formatTimeout } from "./format.ts";

describe("formatTimeout", () => {
  it("muestra el timeout configurado sin redondearlo", () => {
    expect(formatTimeout(30)).toBe("30 s");
    expect(formatTimeout(90)).toBe("90 s");
    expect(formatTimeout(150)).toBe("150 s");
    expect(formatTimeout(300)).toBe("5 min");
    expect(formatTimeout(600)).toBe("10 min");
  });
});
