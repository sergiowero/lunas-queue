import { describe, expect, it } from "vitest";
import { prStateChange } from "./pull-requests.ts";

describe("prStateChange", () => {
  it("an open PR advances to merged or closed", () => {
    expect(prStateChange("open", "merged")).toBe("merged");
    expect(prStateChange("open", "closed")).toBe("closed");
  });

  it("without a change or without a registered PR there is no transition", () => {
    expect(prStateChange("open", "open")).toBeNull();
    expect(prStateChange(null, "merged")).toBeNull();
  });

  it("stale data never reverts a merge or a close", () => {
    expect(prStateChange("merged", "open")).toBeNull();
    expect(prStateChange("merged", "closed")).toBeNull();
    expect(prStateChange("closed", "open")).toBeNull();
    expect(prStateChange("closed", "merged")).toBeNull();
  });
});
