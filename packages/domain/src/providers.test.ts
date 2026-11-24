import { AgentKind } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { ALL_PROVIDERS_ENABLED } from "./providers.ts";

describe("ALL_PROVIDERS_ENABLED", () => {
  it("has every registered provider enabled", () => {
    expect(Object.keys(ALL_PROVIDERS_ENABLED).sort()).toEqual([...AgentKind.options].sort());
    expect(Object.values(ALL_PROVIDERS_ENABLED).every(Boolean)).toBe(true);
  });
});
